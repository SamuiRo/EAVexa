import { chromium }          from 'playwright';
import { readFile, writeFile } from 'fs/promises';
import { existsSync }         from 'fs';
import { pathToFileURL }      from 'url';
import path                   from 'path';
import { build_render_options } from '../../config/render_config.js';
import { print }              from '../../shared/utils.js';

// ─── ImageRenderer ────────────────────────────────────────────────────────────

/**
 * Renders HTML templates to pixel-perfect PNG images using Playwright + Chromium.
 *
 * Usage:
 *   const renderer = new ImageRenderer();
 *   await renderer.connect();
 *   await renderer.render_file('./templates/post.html', './out.png', 'story');
 *   await renderer.close();
 */
export default class ImageRenderer {
  constructor(options = {}) {
    this.browser        = null;
    this.context        = null;

    // Path to Chrome/Chromium binary — falls back to system Playwright default
    this.chrome_path    = options.chrome_path
      ?? process.env.CHROME_PATH
      ?? '/opt/google/chrome/chrome';

    // Default font wait timeout in ms
    this.font_timeout   = options.font_timeout ?? 3000;

    // Extra wait after page load (for animations / late repaints)
    this.settle_ms      = options.settle_ms ?? 200;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Launch browser and create a reusable context.
   * Call once before rendering a batch of images.
   */
  async connect() {
    const launch_opts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',   // consistent font rendering across OSes
        '--disable-lcd-text',           // disable sub-pixel AA for pixel-perfect output
        '--force-color-profile=srgb',   // always sRGB
      ],
    };

    // Use explicit binary if it exists; otherwise let Playwright find its own
    if (existsSync(this.chrome_path)) {
      launch_opts.executablePath = this.chrome_path;
    }

    this.browser = await chromium.launch(launch_opts);
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
   * @returns {Promise<Buffer>}  Raw PNG bytes
   */
  async render_html(html, format, opts = {}) {
    if (!this.browser) throw new Error('Call connect() before render_html()');

    const { viewport, device_scale_factor, clip } = build_render_options(format);

    // Each render gets a fresh context with the correct viewport + DPR
    const context = await this.browser.newContext({
      viewport,
      device_scale_factor,
    });

    const page = await context.newPage();

    try {
      // Inject font preload links into <head> before setting content
      const preloaded_html = opts.font_urls?.length
        ? this._inject_font_preloads(html, opts.font_urls)
        : html;

      // base_url makes relative paths (fonts, images) resolve from the job's input folder
      await page.setContent(preloaded_html, {
        waitUntil: 'networkidle',
        ...(opts.base_url ? { url: opts.base_url } : {}),
      });

      // Wait for document fonts to finish loading
      await page.evaluate(() => document.fonts.ready);

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

  /**
   * Render an HTML file to a PNG file.
   *
   * @param {string}        template_path  Path to .html template
   * @param {string}        output_path    Destination .png path
   * @param {string|Object} format         Format key or raw dimensions
   * @param {Object}        [vars]         Key→value replacements in the HTML ({{KEY}} syntax)
   * @param {Object}        [opts]         Extra options forwarded to render_html()
   * @returns {Promise<{ output_path: string, width: number, height: number, dpr: number }>}
   */
  async render_file(template_path, output_path, format, vars = {}, opts = {}) {
    print(`Rendering: ${path.basename(template_path)}`, 'debug');

    let html = await readFile(template_path, 'utf-8');
    html = this._apply_vars(html, vars);

    // Set base URL to the job's input folder so local assets resolve correctly
    // (local fonts via @font-face src: url('./fonts/...'), images, etc.)
    const base_url = opts.base_url ?? pathToFileURL(template_path).href;

    const png_buffer = await this.render_html(html, format, { ...opts, base_url });

    await writeFile(output_path, png_buffer);

    const { viewport, device_scale_factor } = build_render_options(format);

    return {
      output_path,
      width:  viewport.width  * device_scale_factor,
      height: viewport.height * device_scale_factor,
      dpr:    device_scale_factor,
    };
  }

  /**
   * Render multiple templates in one browser session (efficient batch).
   *
   * @param {Array<{ template: string, output: string, format: string|Object, vars?: Object }>} jobs
   * @returns {Promise<Array>}
   */
  async render_batch(jobs) {
    const results = [];

    print(`Starting batch: ${jobs.length} job(s)`, 'system');

    for (const job of jobs) {
      const result = await this.render_file(
        job.template,
        job.output,
        job.format,
        job.vars  ?? {},
        job.opts  ?? {},
      );
      results.push({ ...result, template: job.template });
    }

    print(`Batch complete`, 'system');
    return results;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Replace {{KEY}} placeholders in HTML with values from vars object.
   *
   * @param {string} html
   * @param {Object} vars
   * @returns {string}
   */
  _apply_vars(html, vars) {
    return Object.entries(vars).reduce(
      (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value),
      html,
    );
  }

  /**
   * Inject <link rel="preload"> tags for font stylesheets into <head>.
   *
   * @param {string}   html
   * @param {string[]} font_urls
   * @returns {string}
   */
  _inject_font_preloads(html, font_urls) {
    const tags = font_urls
      .map(url => `<link rel="preload" href="${url}" as="style" onload="this.rel='stylesheet'">`)
      .join('\n  ');

    return html.replace('</head>', `  ${tags}\n</head>`);
  }
}