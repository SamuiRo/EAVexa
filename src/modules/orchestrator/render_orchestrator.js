import { log } from '../../shared/logger.js';

/**
 * Thin adapter from legacy jobs.json render requests onto RenderService.
 * Concurrency (separate image/video lanes) is owned by core/render_queue.js,
 * so every job can simply be submitted at once.
 */
export default class RenderOrchestrator {
  constructor({ render_service } = {}) {
    this.render_service = render_service;
  }

  /**
   * @param {Array<Object>} render_jobs  Raw render requests (see RenderJobBuilder)
   * @returns {Promise<Array<Object>>} RenderResult per job, same order as input
   */
  async render(render_jobs) {
    return Promise.all(render_jobs.map(job => this._render_one(job)));
  }

  // One start line and one done/failed line per job — enough to see a batch
  // is actually progressing (not stuck) without the per-frame noise the
  // renderers themselves already log at 'debug'.
  async _render_one(job) {
    const label = job.metadata?.job_id ?? job.output?.filename ?? 'job';

    log({ level: 'info', msg: `Rendering "${label}"...` });

    try {
      const result = await this.render_service.render(job);
      log({ level: 'info', msg: `Done "${label}" (${result.bytes} bytes)` });
      return result;
    } catch (error) {
      log({ level: 'error', msg: `Failed "${label}": ${error.message}` });
      throw error;
    }
  }

  /**
   * Close the underlying browser pool.
   */
  async close() {
    await this.render_service.close();
  }
}
