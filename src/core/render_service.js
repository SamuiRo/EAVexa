import path from 'path';
import { readFile, rm, readdir } from 'fs/promises';
import { pathToFileURL } from 'url';
import { normalize_request } from './render_request.js';
import { RenderError } from './errors.js';
import { new_render_id, new_job_id } from './ids.js';
import { apply_vars } from '../shared/html_template.js';
import { log } from '../shared/logger.js';
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
 */
export default class RenderService {
  constructor({ registry, pool, queue, storage, job_store, notifier } = {}) {
    this.registry  = registry;
    this.pool      = pool;
    this.queue     = queue;
    this.storage   = storage;
    this.job_store = job_store;
    this.notifier  = notifier;
    this._controllers = new Map(); // job_id -> AbortController, for cancel()
    this._running     = new Map(); // job_id -> in-flight _run_job() promise
  }

  /**
   * Run once at process startup, before accepting renders:
   * 1. jobs left 'queued'/'running' by a process that died mid-render are
   *    marked failed (INTERRUPTED) and their webhook (if any) fires;
   * 2. webhook retries scheduled by a since-exited process are resumed;
   * 3. orphaned video frame directories in TMP_DIR are removed.
   */
  async start() {
    if (this.job_store) {
      const orphaned = await this.job_store.orphaned_running();

      for (const job of orphaned) {
        const updated = await this.job_store.update(job.id, {
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: { code: 'INTERRUPTED', message: 'Process restarted while this job was running', details: {} },
        });

        if (this.notifier && updated.callback) {
          this.notifier.notify(job.id, 'render.failed').catch(() => {});
        }
      }
    }

    if (this.notifier) {
      await this.notifier.resume_pending();
    }

    await this._cleanup_orphaned_frames();
  }

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

  /**
   * Create a durable job record and run it in the background. Returns
   * immediately with the queued job; `done` resolves once the job (and its
   * first webhook attempt, if any) has finished.
   *
   * @param {Object} raw_request
   * @returns {Promise<{ job: Object, done: Promise<void> }>}
   */
  async submit(raw_request) {
    if (!this.job_store) {
      throw new RenderError('INTERNAL', 'submit() requires a job_store — none was configured');
    }

    const request = await normalize_request(raw_request, { registry: this.registry });
    const job = this._build_initial_job(request);
    await this.job_store.create(job);

    const done = this._run_job(job.id, request);
    this._running.set(job.id, done);
    done.finally(() => this._running.delete(job.id));

    return { job, done };
  }

  /**
   * Cancel a queued or running job. Waits for the in-flight render to
   * actually settle (via AbortSignal) before recording 'cancelled', so a
   * cancel that loses the race against natural completion doesn't clobber a
   * successful result. Only effective within the same process that is
   * executing the job — no cross-process signaling exists until the HTTP
   * server lands.
   */
  async cancel(job_id) {
    if (!this.job_store) {
      throw new RenderError('INTERNAL', 'cancel() requires a job_store — none was configured');
    }

    const job = await this.job_store.get(job_id);
    if (!job) throw new RenderError('JOB_NOT_FOUND', `Job "${job_id}" was not found`, { job_id });

    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      return job;
    }

    this._controllers.get(job_id)?.abort();

    const running = this._running.get(job_id);
    if (running) await running.catch(() => {});

    const settled = await this.job_store.get(job_id);
    if (settled.status === 'done') return settled; // completed before the abort took effect

    return this.job_store.update(job_id, {
      status: 'cancelled',
      finished_at: settled.finished_at ?? new Date().toISOString(),
      error: { code: 'CANCELLED', message: 'Cancelled by user', details: {} },
    });
  }

  async close() {
    await this.pool.close();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  _build_initial_job(request) {
    return {
      id: new_job_id(),
      status: 'queued',
      mode: 'async',
      progress: { phase: 'queued', current: 0, total: request.cost.frames, ratio: 0 },
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      template: request.template?.name ?? null,
      type: request.video ? 'video' : 'image',
      metadata: request.metadata,
      result: null,
      error: null,
      callback: request.callback
        ? { url: request.callback.url, headers: request.callback.headers ?? {}, state: 'pending', delivered: false, attempts: [] }
        : null,
    };
  }

  async _run_job(job_id, request) {
    await this.job_store.update(job_id, { status: 'running', started_at: new Date().toISOString() });

    const controller = new AbortController();
    this._controllers.set(job_id, controller);

    const on_progress = progress => {
      this.job_store.update(job_id, { progress }).catch(() => {});
    };

    try {
      const lane = request.video ? 'video' : 'image';
      const result = await this.queue.enqueue(
        () => this._execute(request, on_progress),
        { lane, timeout_ms: request.options.timeout_ms, signal: controller.signal },
      );

      await this.job_store.update(job_id, {
        status: 'done',
        finished_at: new Date().toISOString(),
        result,
        progress: { phase: 'done', current: request.cost.frames, total: request.cost.frames, ratio: 1 },
      });

      if (this.notifier) await this.notifier.notify(job_id, 'render.completed');
    } catch (error) {
      // If this was an abort, cancel() is awaiting this same promise and will
      // overwrite this 'failed' record with the authoritative 'cancelled' one.
      const payload = error instanceof RenderError ? error.toJSON() : { code: 'INTERNAL', message: error.message };
      await this.job_store.update(job_id, { status: 'failed', finished_at: new Date().toISOString(), error: payload });

      if (this.notifier) await this.notifier.notify(job_id, 'render.failed');
    } finally {
      this._controllers.delete(job_id);
    }
  }

  async _cleanup_orphaned_frames() {
    try {
      const entries = await readdir(TMP_DIR);

      await Promise.all(
        entries
          .filter(name => name.startsWith('.eavexa_'))
          .map(name => rm(path.join(TMP_DIR, name), { recursive: true, force: true }).catch(() => {})),
      );
    } catch (error) {
      log({ level: 'warn', msg: `Could not clean up TMP_DIR frame leftovers: ${error.message}` });
    }
  }

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
