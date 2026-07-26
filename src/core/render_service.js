import path from 'path';
import { readFile, rm } from 'fs/promises';
import { pathToFileURL } from 'url';
import { normalize_request } from './render_request.js';
import { RenderError } from './errors.js';
import { new_render_id } from './ids.js';
import { apply_vars } from '../shared/html_template.js';
import { TMP_DIR } from '../config/app_config.js';

const VIDEO_MIME_TYPES = {
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.mkv':  'video/x-matroska',
};

/**
 * The one core render entry point behind every front-end (CLI, HTTP,
 * legacy jobs.json). See docs/specification.md §5.11.
 *
 * Крок 1 scope: only render() (synchronous). Job submission/polling
 * (submit/cancel) lands with job_store.js in Крок 3.
 */
export default class RenderService {
  constructor({ registry, pool, queue, storage } = {}) {
    this.registry = registry;
    this.pool     = pool;
    this.queue    = queue;
    this.storage  = storage;
  }

  /**
   * Reserved for startup recovery (orphaned jobs, pending webhooks) once
   * job_store.js exists — currently a no-op.
   */
  async start() {}

  /**
   * @param {Object} raw_request
   * @param {{ signal?: AbortSignal, on_progress?: Function }} [opts]
   * @returns {Promise<Object>} RenderResult, see docs/specification.md §6.5
   */
  async render(raw_request, { signal, on_progress } = {}) {
    const request = await normalize_request(raw_request, { registry: this.registry });
    const lane = request.video ? 'video' : 'image';

    return this.queue.enqueue(
      () => this._execute(request, on_progress),
      { lane, timeout_ms: request.options.timeout_ms, signal },
    );
  }

  async close() {
    await this.pool.close();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  async _execute(request, on_progress) {
    const started_at = Date.now();
    const { html, base_url } = await this._load_html(request);
    const prepared_html = apply_vars(html, request.vars);

    return request.video
      ? this._render_video(request, prepared_html, base_url, started_at, on_progress)
      : this._render_image(request, prepared_html, base_url, started_at);
  }

  async _load_html(request) {
    const { source } = request;

    switch (source.kind) {
      case 'registry': {
        const html = await this.registry.read_html(source.name);
        return { html, base_url: pathToFileURL(source.base_dir + path.sep).href };
      }

      case 'inline':
        return { html: source.html, base_url: source.base_dir };

      case 'file': {
        const html = await readFile(source.path, 'utf-8');
        return { html, base_url: pathToFileURL(source.path).href };
      }

      case 'url': {
        let response;

        try {
          response = await fetch(source.url);
        } catch (error) {
          throw new RenderError('TEMPLATE_FETCH_FAILED', `Cannot fetch template: ${error.message}`, { url: source.url });
        }

        if (!response.ok) {
          throw new RenderError('TEMPLATE_FETCH_FAILED', `Template fetch failed with status ${response.status}`, {
            url: source.url, status: response.status,
          });
        }

        return { html: await response.text(), base_url: source.url };
      }

      default:
        throw new RenderError('INVALID_REQUEST', `Unknown source kind "${source.kind}"`);
    }
  }

  async _render_image(request, html, base_url, started_at) {
    const buffer = await this.pool.with_image(renderer => renderer.render_html(
      html,
      this._viewport_format(request.format),
      { base_url },
    ));

    const stored = await this.storage.put(buffer, {
      job_id:   request.render_id,
      filename: request.output.filename,
      dir:      request.output.dir,
    });

    return this._build_result(request, stored, {
      type: 'image',
      mime: 'image/png',
      width:  request.format.width * request.format.device_scale_factor,
      height: request.format.height * request.format.device_scale_factor,
      dpr:    request.format.device_scale_factor,
      duration: null,
      fps:      null,
      frames:   null,
    }, started_at);
  }

  async _render_video(request, html, base_url, started_at, on_progress) {
    const temp_path = path.join(TMP_DIR, `eavexa_${new_render_id()}${path.extname(request.output.filename)}`);

    const render_result = await this.pool.with_video(renderer => renderer.render_html(
      html,
      temp_path,
      this._viewport_format(request.format),
      { base_url, video: request.video, on_progress },
    ));

    let stored;

    try {
      stored = await this.storage.finalize(temp_path, {
        job_id:   request.render_id,
        filename: request.output.filename,
        dir:      request.output.dir,
      });
    } finally {
      await rm(temp_path, { force: true });
    }

    return this._build_result(request, stored, {
      type: 'video',
      mime: VIDEO_MIME_TYPES[path.extname(request.output.filename).toLowerCase()] ?? 'application/octet-stream',
      width:  render_result.width,
      height: render_result.height,
      dpr:    render_result.dpr,
      duration: render_result.duration,
      fps:      render_result.fps,
      frames:   render_result.frames,
    }, started_at);
  }

  _viewport_format(format) {
    return { width: format.width, height: format.height, device_scale_factor: format.device_scale_factor };
  }

  _build_result(request, stored, media, started_at) {
    return {
      render_id: request.render_id,
      ...media,
      filename: request.output.filename,
      bytes:    stored.bytes,
      checksum: stored.checksum,
      storage:  stored.storage,
      path:     stored.path,
      local_path: stored.local_path,
      url:      stored.url,
      data:     null,
      timings:  { total_ms: Date.now() - started_at },
      metadata: request.metadata,
    };
  }
}
