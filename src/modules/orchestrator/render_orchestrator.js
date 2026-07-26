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
    return Promise.all(render_jobs.map(job => this.render_service.render(job)));
  }

  /**
   * Close the underlying browser pool.
   */
  async close() {
    await this.render_service.close();
  }
}
