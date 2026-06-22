import { mkdir, readFile, rm } from 'fs/promises';
import { existsSync }      from 'fs';
import { pathToFileURL }   from 'url';
import path                from 'path';
import { chromium }        from 'playwright';
import { CHROME_PATH }     from '../../config/app_config.js';
import { build_render_options } from '../../config/render_config.js';
import { print }           from '../../shared/utils.js';
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
    this.settle_ms    = options.settle_ms ?? 100;
    this.encoder      = options.encoder ?? new FfmpegEncoder(options.ffmpeg ?? {});
  }

  /**
   * Launch browser and keep it available for a video batch.
   */
  async connect() {
    const launch_opts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
        '--disable-lcd-text',
        '--force-color-profile=srgb',
      ],
    };

    if (existsSync(this.chrome_path)) {
      launch_opts.executablePath = this.chrome_path;
    }

    this.browser = await chromium.launch(launch_opts);
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
   * Render an HTML file to a video file.
   *
   * @param {string}        template_path
   * @param {string}        output_path
   * @param {string|Object} format
   * @param {Object}        [vars]
   * @param {Object}        [video]
   * @param {Object}        [opts]
   * @returns {Promise<Object>}
   */
  async render_file(template_path, output_path, format, vars = {}, video = {}, opts = {}) {
    print(`Rendering video: ${path.basename(template_path)}`, 'debug');

    let html = await readFile(template_path, 'utf-8');
    html = this._apply_vars(html, vars);

    const base_url = opts.base_url
      ?? pathToFileURL(path.dirname(template_path) + path.sep).href;

    return this.render_html(html, output_path, format, {
      ...opts,
      base_url,
      video,
    });
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
        viewport:            render_opts.viewport,
        device_scale_factor: render_opts.device_scale_factor,
      });

      const page = await context.newPage();

      await mkdir(path.dirname(output_path), { recursive: true });
      await this._load_page(page, html, opts);

      print(`Capturing ${total_frames} frame(s) at ${video_options.fps}fps`, 'system');

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

        if (this._should_log_frame(frame_index, total_frames)) {
          print(`Frame ${frame_index + 1}/${total_frames}`, 'debug');
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

  /**
   * Render multiple videos in one browser session.
   *
   * @param {Array<Object>} jobs
   * @returns {Promise<Array>}
   */
  async render_batch(jobs) {
    const results = [];

    print(`Starting video batch: ${jobs.length} job(s)`, 'system');

    for (const job of jobs) {
      const result = await this.render_file(
        job.template,
        job.output,
        job.format,
        job.vars  ?? {},
        job.video ?? {},
        job.opts  ?? {},
      );
      results.push({ ...result, template: job.template });
    }

    print('Video batch complete', 'system');
    return results;
  }

  async _load_page(page, html, opts) {
    const with_base = opts.base_url
      ? this._inject_base_url(html, opts.base_url)
      : html;

    const preloaded_html = opts.font_urls?.length
      ? this._inject_font_preloads(with_base, opts.font_urls)
      : with_base;

    await page.setContent(preloaded_html, {
      waitUntil: 'networkidle',
    });

    await page.evaluate(() => document.fonts.ready);

    if (this.settle_ms > 0) {
      await page.waitForTimeout(this.settle_ms);
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
    const result = await page.evaluate(async state => {
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

      if (typeof window.eavexa_render_frame === 'function') {
        await window.eavexa_render_frame(state);
      }

      return { failed_animation_count };
    }, frame_state);

    if (result.failed_animation_count > 0 && frame_state.frame === 0) {
      print(`Skipped ${result.failed_animation_count} unsupported animation timeline(s)`, 'warning');
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

  _apply_vars(html, vars) {
    return Object.entries(vars).reduce(
      (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value),
      html,
    );
  }

  _inject_base_url(html, base_url) {
    if (/<base\s/i.test(html)) {
      return html;
    }

    const tag = `<base href="${this._escape_attr(base_url)}">`;

    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>\n  ${tag}`);
    }

    return `${tag}\n${html}`;
  }

  _inject_font_preloads(html, font_urls) {
    const tags = font_urls
      .map(url => `<link rel="preload" href="${this._escape_attr(url)}" as="style" onload="this.rel='stylesheet'">`)
      .join('\n  ');

    return html.replace('</head>', `  ${tags}\n</head>`);
  }

  _escape_attr(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
}
