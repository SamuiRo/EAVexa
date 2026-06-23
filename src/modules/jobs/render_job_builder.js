import { mkdirSync } from 'fs';
import path          from 'path';
import { INPUTS_DIR, OUTPUT_DIR } from '../../config/app_config.js';

/**
 * Converts user jobs into concrete renderer jobs with absolute paths.
 */
export default class RenderJobBuilder {
  constructor(options = {}) {
    this.inputs_dir = options.inputs_dir ?? INPUTS_DIR;
    this.output_dir = options.output_dir ?? OUTPUT_DIR;
  }

  /**
   * Build renderer-ready job objects.
   *
   * @param {Array<Object>} jobs
   * @returns {Array<Object>}
   */
  build_render_jobs(jobs) {
    return jobs.map(job => this.build_render_job(job));
  }

  build_render_job(job) {
    const job_input_dir  = path.join(this.inputs_dir, job.id);
    const job_output_dir = path.join(this.output_dir, job.id);

    mkdirSync(job_output_dir, { recursive: true });

    return {
      template: path.join(job_input_dir, job.template),
      output:   path.join(job_output_dir, job.output),
      format:   job.format,
      vars:     job.vars ?? {},
      video:    job.video ?? null,
      opts:     job.opts ?? {},
    };
  }
}
