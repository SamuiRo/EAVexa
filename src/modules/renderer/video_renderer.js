import { mkdir, rm } from 'fs/promises';
import path                from 'path';
import { chromium }        from 'playwright';
import { CHROME_PATH, NETWORK_TIMEOUT_MS, FONT_TIMEOUT_MS, VIDEO_TAG_TIMEOUT_MS } from '../../config/app_config.js';
import { build_render_options } from '../../config/render_config.js';
import { build_launch_args, resolve_executable_path, prime_local_file_origin } from '../../shared/chromium.js';
import { inject_base_url, inject_font_preloads } from '../../shared/html_template.js';
import { sleep }           from '../../shared/utils.js';
import { log }             from '../../shared/logger.js';
import FfmpegEncoder       from './ffmpeg_encoder.js';

const DEFAULT_VIDEO_OPTIONS = {
  fps:         30,
  crf:         18,
  preset:      'medium',
  keep_frames: false,
};

/**
 * Renders HTML templates to videos through deterministic PNG frame capture.
 */
export default class VideoRenderer {
  constructor(options = {}) {
    this.browser      = null;
    this.chrome_path  = options.chrome_path ?? CHROME_PATH;
    this.network_timeout_ms = options.network_timeout_ms ?? NETWORK_TIMEOUT_MS;
    this.font_timeout_ms    = options.font_timeout_ms ?? FONT_TIMEOUT_MS;
    this.video_timeout_ms   = options.video_timeout_ms ?? VIDEO_TAG_TIMEOUT_MS;
    // Bounds the wait for a single per-frame video seek, not just the initial
    // metadata load — capped low so a stuck video can't stall hundreds of frames.
    this.video_seek_timeout_ms = Math.min(this.video_timeout_ms, 2000);
    this.settle_ms    = options.settle_ms ?? 100;
    this.encoder      = options.encoder ?? new FfmpegEncoder(options.ffmpeg ?? {});
  }

  /**
   * Launch browser and keep it available for a video batch.
   */
  async connect() {
    this.browser = await chromium.launch({
      headless: true,
      args: build_launch_args(),
      executablePath: resolve_executable_path(this.chrome_path),
    });
  }

  /**
   * Close browser after rendering.
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Render an HTML string to a video file.
   *
   * @param {string}        html
   * @param {string}        output_path
   * @param {string|Object} format
   * @param {Object}        [opts]
   * @returns {Promise<Object>}
   */
  async render_html(html, output_path, format, opts = {}) {
    if (!this.browser) throw new Error('Call connect() before render_html()');

    const video_options = this._normalize_video_options(opts.video ?? {});
    const render_opts   = build_render_options(format);
    const frames_dir    = await this._prepare_frames_dir(output_path, video_options);
    const total_frames  = Math.max(1, Math.round(video_options.duration * video_options.fps));

    let context = null;

    try {
      context = await this.browser.newContext({
        viewport:          render_opts.viewport,
        deviceScaleFactor: render_opts.device_scale_factor,
      });

      const page = await context.newPage();
      page.setDefaultTimeout(this.network_timeout_ms);

      const on_progress = opts.on_progress ?? (() => {});

      await mkdir(path.dirname(output_path), { recursive: true });
      on_progress({ phase: 'load', current: 0, total: total_frames, ratio: 0 });
      await this._load_page(page, html, opts);
      on_progress({ phase: 'load', current: 0, total: total_frames, ratio: 0.05 });

      log({ level: 'info', msg: `Capturing ${total_frames} frame(s) at ${video_options.fps}fps` });

      for (let frame_index = 0; frame_index < total_frames; frame_index += 1) {
        const frame_state = this._build_frame_state(frame_index, total_frames, video_options);
        const frame_path  = path.join(frames_dir, this._frame_name(frame_index));

        await this._seek_frame(page, frame_state);
        await this._settle_frame(page);

        await page.screenshot({
          path:           frame_path,
          type:           'png',
          clip:           render_opts.clip,
          animations:     'allow',
          omitBackground: false,
        });

        on_progress({
          phase:   'capture',
          current: frame_index + 1,
          total:   total_frames,
          ratio:   0.05 + 0.8 * ((frame_index + 1) / total_frames),
        });

        if (this._should_log_frame(frame_index, total_frames)) {
          log({ level: 'debug', msg: `Frame ${frame_index + 1}/${total_frames}` });
        }
      }

      const encoded = await this.encoder.encode_frames({
        frames_dir,
        output_path,
        fps:      video_options.fps,
        crf:      video_options.crf,
        preset:   video_options.preset,
        webm_crf: video_options.webm_crf,
      });

      on_progress({ phase: 'encode', current: total_frames, total: total_frames, ratio: 0.97 });

      return {
        output_path,
        width:       render_opts.viewport.width * render_opts.device_scale_factor,
        height:      render_opts.viewport.height * render_opts.device_scale_factor,
        dpr:         render_opts.device_scale_factor,
        duration:    video_options.duration,
        fps:         video_options.fps,
        frames:      total_frames,
        container:   encoded.container,
        frames_dir:  video_options.keep_frames ? frames_dir : null,
        type:        'video',
      };
    } finally {
      if (context) {
        await context.close();
      }

      if (!video_options.keep_frames) {
        await rm(frames_dir, { recursive: true, force: true });
      }
    }
  }

  async _load_page(page, html, opts) {
    const with_base = opts.base_url
      ? inject_base_url(html, opts.base_url)
      : html;

    const preloaded_html = opts.font_urls?.length
      ? inject_font_preloads(with_base, opts.font_urls)
      : with_base;

    await prime_local_file_origin(page, opts.base_url);

    await page.setContent(preloaded_html, {
      waitUntil: 'networkidle',
      timeout:   this.network_timeout_ms,
    });

    await this._wait_for_fonts(page);
    await this._prepare_videos(page);

    if (this.settle_ms > 0) {
      await page.waitForTimeout(this.settle_ms);
    }
  }

  /**
   * Wait for document.fonts.ready, bounded by font_timeout_ms so a stuck
   * webfont never hangs the render — proceeds with a warning instead.
   */
  async _wait_for_fonts(page) {
    let timed_out = false;

    await Promise.race([
      page.evaluate(() => document.fonts.ready),
      sleep(this.font_timeout_ms).then(() => { timed_out = true; }),
    ]);

    if (timed_out) {
      log({ level: 'warn', msg: `Font loading exceeded ${this.font_timeout_ms}ms — rendering with fonts as-is` });
    }
  }

  /**
   * Pause and mute every <video> element (playback is driven per-frame by
   * _seek_frame, not real time) and wait for readyState HAVE_METADATA so
   * `duration` is known before the frame loop starts. Elements marked
   * `data-eavexa-skip` are left alone for templates with custom video control.
   */
  async _prepare_videos(page) {
    let timed_out = false;

    await page.evaluate(() => {
      for (const video of document.querySelectorAll('video')) {
        if (video.hasAttribute('data-eavexa-skip')) continue;

        video.pause();
        video.muted = true;
        video.autoplay = false;
        video.loop = false;

        // preload="none" means the browser never fetches metadata on its own,
        // so `loadedmetadata` would never fire and the wait below would burn
        // the whole timeout, leaving `duration` unknown and every frame blank.
        if (video.preload === 'none') {
          video.preload = 'auto';
          video.load();
        }
      }
    });

    await Promise.race([
      page.evaluate(() => Promise.all(
        Array.from(document.querySelectorAll('video'))
          .filter(video => !video.hasAttribute('data-eavexa-skip'))
          .map(video => (video.readyState >= 1 ? null : new Promise(resolve => {
            video.addEventListener('loadedmetadata', resolve, { once: true });
            video.addEventListener('error', resolve, { once: true });
          }))),
      )),
      sleep(this.video_timeout_ms).then(() => { timed_out = true; }),
    ]);

    if (timed_out) {
      log({ level: 'warn', msg: `Video metadata loading exceeded ${this.video_timeout_ms}ms — rendering with videos as-is` });
    }
  }

  async _prepare_frames_dir(output_path, video_options) {
    const output_dir  = path.dirname(output_path);
    const output_name = path.basename(output_path, path.extname(output_path));
    const dir_name    = video_options.keep_frames
      ? `${output_name}_frames`
      : `.eavexa_${output_name}_frames_${Date.now()}`;
    const frames_dir  = path.join(output_dir, dir_name);

    await rm(frames_dir, { recursive: true, force: true });
    await mkdir(frames_dir, { recursive: true });

    return frames_dir;
  }

  async _seek_frame(page, frame_state) {
    const result = await page.evaluate(async ({ state, video_seek_timeout_ms }) => {
      const root = document.documentElement;

      root.style.setProperty('--eavexa-time', `${state.time_s}s`);
      root.style.setProperty('--eavexa-time-ms', `${state.time_ms}ms`);
      root.style.setProperty('--eavexa-progress', String(state.progress));
      root.style.setProperty('--eavexa-frame', String(state.frame));

      let failed_animation_count = 0;

      for (const animation of document.getAnimations({ subtree: true })) {
        try {
          animation.pause();
          animation.currentTime = state.time_ms;
        } catch (error) {
          failed_animation_count += 1;
        }
      }

      // Videos loop over their own duration so a short background clip keeps
      // playing for the full render instead of freezing on its last frame.
      // Sampled at `frame_time_s` (frame / fps) rather than `time_s`, which
      // spans [0, duration] inclusive: that stretches the gap between frames
      // to duration/(total-1) and lands the final frame exactly on `duration`,
      // so a clip as long as the render would wrap back to its first frame.
      const videos = Array.from(document.querySelectorAll('video'))
        .filter(video => !video.hasAttribute('data-eavexa-skip'));
      let failed_video_seek_count = 0;

      await Promise.all(videos.map(video => new Promise(resolve => {
        const duration = video.duration;

        if (!Number.isFinite(duration) || duration <= 0) {
          resolve();
          return;
        }

        const target = state.frame_time_s % duration;

        if (Math.abs(video.currentTime - target) < 0.001) {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          failed_video_seek_count += 1;
          resolve();
        }, video_seek_timeout_ms);

        video.addEventListener('seeked', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });

        video.currentTime = target;
      })));

      if (typeof window.eavexa_render_frame === 'function') {
        await window.eavexa_render_frame(state);
      }

      return { failed_animation_count, failed_video_seek_count };
    }, { state: frame_state, video_seek_timeout_ms: this.video_seek_timeout_ms });

    if (result.failed_animation_count > 0 && frame_state.frame === 0) {
      log({ level: 'warn', msg: `Skipped ${result.failed_animation_count} unsupported animation timeline(s)` });
    }

    if (result.failed_video_seek_count > 0) {
      log({ level: 'warn', msg: `Frame ${frame_state.frame_number}: ${result.failed_video_seek_count} video seek(s) exceeded ${this.video_seek_timeout_ms}ms` });
    }
  }

  async _settle_frame(page) {
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  }

  _normalize_video_options(video) {
    if (video.duration === undefined) {
      throw new Error('Video job is missing required "video.duration"');
    }

    const duration = Number(video.duration);
    const fps      = Number(video.fps ?? DEFAULT_VIDEO_OPTIONS.fps);
    const crf      = Number(video.crf ?? DEFAULT_VIDEO_OPTIONS.crf);

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('"video.duration" must be a positive number of seconds');
    }

    if (!Number.isFinite(fps) || fps <= 0) {
      throw new Error('"video.fps" must be a positive number');
    }

    if (!Number.isFinite(crf) || crf < 0 || crf > 63) {
      throw new Error('"video.crf" must be a number from 0 to 63');
    }

    return {
      ...DEFAULT_VIDEO_OPTIONS,
      ...video,
      duration,
      fps,
      crf,
      keep_frames: video.keep_frames === true,
    };
  }

  _build_frame_state(frame_index, total_frames, video_options) {
    const progress     = total_frames === 1 ? 1 : frame_index / (total_frames - 1);
    const time_s       = progress * video_options.duration;
    const frame_time_s = frame_index / video_options.fps;

    return {
      frame:        frame_index,
      frame_number: frame_index + 1,
      total_frames,
      fps:          video_options.fps,
      duration:     video_options.duration,
      progress,
      time_s,
      time_ms:      time_s * 1000,
      frame_time_s,
    };
  }

  _should_log_frame(frame_index, total_frames) {
    const step = Math.max(1, Math.floor(total_frames / 10));

    return frame_index === 0
      || frame_index === total_frames - 1
      || (frame_index + 1) % step === 0;
  }

  _frame_name(frame_index) {
    return `frame_${String(frame_index).padStart(6, '0')}.png`;
  }
}
