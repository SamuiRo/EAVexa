import ImageRenderer from '../renderer/image_renderer.js';
import VideoRenderer from '../renderer/video_renderer.js';
import { print }     from '../../shared/utils.js';

/**
 * Runs image and video render jobs through their dedicated renderers.
 */
export default class RenderOrchestrator {
  constructor(options = {}) {
    this.image_renderer = options.image_renderer ?? new ImageRenderer();
    this.video_renderer = options.video_renderer ?? new VideoRenderer();
  }

  /**
   * Render all jobs and return combined results.
   *
   * @param {Array<Object>} render_jobs
   * @returns {Promise<Array<Object>>}
   */
  async render(render_jobs) {
    const { image_jobs, video_jobs } = this.split_render_jobs(render_jobs);

    // Image and video jobs run on separate browser connections, so they run
    // concurrently — a long video batch no longer blocks queued images (and
    // vice versa). Per-type ordering within each batch stays sequential.
    const [image_results, video_results] = await Promise.all([
      image_jobs.length > 0 ? this.render_image_jobs(image_jobs) : [],
      video_jobs.length > 0 ? this.render_video_jobs(video_jobs) : [],
    ]);

    return [...image_results, ...video_results];
  }

  /**
   * Close any browser sessions opened by child renderers.
   */
  async close() {
    await this.image_renderer.close();
    await this.video_renderer.close();
  }

  split_render_jobs(render_jobs) {
    return {
      image_jobs: render_jobs.filter(job => !job.video),
      video_jobs: render_jobs.filter(job => job.video),
    };
  }

  async render_image_jobs(image_jobs) {
    print('Connecting to browser for image jobs', 'system');
    await this.image_renderer.connect();

    print('Rendering images...', 'system');
    return this.image_renderer.render_batch(image_jobs);
  }

  async render_video_jobs(video_jobs) {
    print('Connecting to browser for video jobs', 'system');
    await this.video_renderer.connect();

    print('Rendering videos...', 'system');
    return this.video_renderer.render_batch(video_jobs);
  }
}
