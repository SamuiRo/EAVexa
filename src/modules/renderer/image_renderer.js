import { chromium }          from 'playwright';
import { build_render_options } from '../../config/render_config.js';
import { CHROME_PATH, NETWORK_TIMEOUT_MS, FONT_TIMEOUT_MS, VIDEO_TAG_TIMEOUT_MS } from '../../config/app_config.js';
import { build_launch_args, resolve_executable_path, prime_local_file_origin } from '../../shared/chromium.js';
import { inject_base_url, inject_font_preloads } from '../../shared/html_template.js';
import { sleep }              from '../../shared/utils.js';
import { log }                from '../../shared/logger.js';

// ─── ImageRenderer ────────────────────────────────────────────────────────────

/**
 * Renders HTML templates to pixel-perfect PNG images using Playwright + Chromium.
 *
 * Usage:
 *   const renderer = new ImageRenderer();
 *   await renderer.connect();
 *   const png = await renderer.render_html(html, 'story');
 *   await renderer.close();
 */
export default class ImageRenderer {
  constructor(options = {}) {
    this.browser        = null;

    // Path to Chrome/Chromium binary — falls back to Playwright's bundled Chromium
    this.chrome_path    = options.chrome_path ?? CHROME_PATH;

    // Timeouts
    this.network_timeout_ms = options.network_timeout_ms ?? NETWORK_TIMEOUT_MS;
    this.font_timeout_ms    = options.font_timeout_ms ?? FONT_TIMEOUT_MS;
    this.video_timeout_ms   = options.video_timeout_ms ?? VIDEO_TAG_TIMEOUT_MS;

    // Extra wait after page load (for animations / late repaints)
    this.settle_ms      = options.settle_ms ?? 200;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Launch browser and create a reusable context.
   * Call once before rendering a batch of images.
   */
  async connect() {
    this.browser = await chromium.launch({
      headless: true,
      args: build_launch_args(),
      executablePath: resolve_executable_path(this.chrome_path),
    });
  }

  /**
   * Close browser — call after all rendering is done.
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ─── Core render ────────────────────────────────────────────────────────────

  /**
   * Render an HTML string to a PNG buffer.
   *
   * @param {string}        html        Full HTML document string
   * @param {string|Object} format      Format key or { width, height, device_scale_factor }
   * @param {Object}        [opts]
   * @param {string[]}      [opts.font_urls]   Extra @font-face stylesheet URLs to preload
   * @param {string}        [opts.base_url]    Base URL for resolving relative assets
   * @returns {Promise<Buffer>}  Raw PNG bytes
   */
  async render_html(html, format, opts = {}) {
    if (!this.browser) throw new Error('Call connect() before render_html()');

    const { viewport, device_scale_factor, clip } = build_render_options(format);

    // Each render gets a fresh context with the correct viewport + DPR
    const context = await this.browser.newContext({
      viewport,
      deviceScaleFactor: device_scale_factor,
    });

    const page = await context.newPage();
    page.setDefaultTimeout(this.network_timeout_ms);

    try {
      // base_url makes relative paths (fonts, images) resolve via <base href>
      let prepared_html = opts.base_url ? inject_base_url(html, opts.base_url) : html;

      prepared_html = opts.font_urls?.length
        ? inject_font_preloads(prepared_html, opts.font_urls)
        : prepared_html;

      await prime_local_file_origin(page, opts.base_url);

      await page.setContent(prepared_html, {
        waitUntil: 'networkidle',
        timeout:   this.network_timeout_ms,
      });

      await this._wait_for_fonts(page);
      await this._prepare_videos(page);

      // Extra settle time for CSS transitions / late paints
      if (this.settle_ms > 0) {
        await page.waitForTimeout(this.settle_ms);
      }

      const screenshot = await page.screenshot({
        type:    'png',
        clip,
        animations: 'disabled',   // freeze CSS animations at t=0
        omitBackground: false,
      });

      return screenshot;

    } finally {
      await context.close();
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

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
   * Pause, mute, and freeze every <video> element on its first frame —
   * mirrors `animations: 'disabled'` freezing CSS animations at t=0, so an
   * image job captures a stable frame instead of whatever the video happened
   * to autoplay to. Elements marked `data-eavexa-skip` are left alone.
   */
  async _prepare_videos(page) {
    let timed_out = false;

    await Promise.race([
      page.evaluate(() => Promise.all(
        Array.from(document.querySelectorAll('video'))
          .filter(video => !video.hasAttribute('data-eavexa-skip'))
          .map(video => new Promise(resolve => {
            video.pause();
            video.muted = true;
            video.autoplay = false;
            video.loop = false;

            const freeze_at_start = () => {
              if (video.currentTime === 0) {
                resolve();
                return;
              }

              video.addEventListener('seeked', resolve, { once: true });
              video.currentTime = 0;
            };

            if (video.readyState >= 1) {
              freeze_at_start();
            } else {
              video.addEventListener('loadedmetadata', freeze_at_start, { once: true });
              video.addEventListener('error', resolve, { once: true });
            }
          })),
      )),
      sleep(this.video_timeout_ms).then(() => { timed_out = true; }),
    ]);

    if (timed_out) {
      log({ level: 'warn', msg: `Video loading exceeded ${this.video_timeout_ms}ms — rendering with videos as-is` });
    }
  }
}
