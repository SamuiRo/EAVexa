import path from 'path';
import { INPUTS_DIR } from '../../config/app_config.js';

/**
 * Converts user jobs.json entries into raw render requests, ready for
 * normalize_request() / RenderService.render(). Output path planning
 * (dated dirs, atomic writes) is owned by core/storage_adapter.js — this
 * builder only points at the job's own output folder (`OUTPUT_DIR/<job_id>/`),
 * matching the layout documented in README.md/docs/architecture.md.
 */
export default class RenderJobBuilder {
  constructor(options = {}) {
    this.inputs_dir = options.inputs_dir ?? INPUTS_DIR;
  }

  /**
   * @param {Array<Object>} jobs
   * @returns {Array<Object>} Raw render requests, one per job.
   */
  build_render_jobs(jobs) {
    return jobs.map(job => this.build_render_job(job));
  }

  build_render_job(job) {
    const job_input_dir = path.join(this.inputs_dir, job.id);

    return {
      source: { path: path.join(job_input_dir, job.template) },
      format: job.format,
      vars:   job.vars ?? {},
      video:  job.video ?? null,
      output: { filename: job.output, dir: job.id },
      metadata: { job_id: job.id },
    };
  }
}
