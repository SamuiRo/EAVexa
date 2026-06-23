import path         from 'path';
import { readFile } from 'fs/promises';
import { JOBS_FILE } from '../../config/app_config.js';
import { VIDEO_OUTPUT_EXTENSIONS } from '../../config/video_config.js';

/**
 * Loads and validates enabled render jobs from jobs.json.
 */
export default class JobLoader {
  constructor(options = {}) {
    this.jobs_file = options.jobs_file ?? JOBS_FILE;
  }

  /**
   * Read jobs config and return enabled jobs only.
   *
   * @returns {Promise<Array<Object>>}
   */
  async load_jobs() {
    let raw;

    try {
      raw = await readFile(this.jobs_file, 'utf-8');
    } catch {
      throw new Error(`Cannot read jobs config: ${this.jobs_file}`);
    }

    const config = this._parse_config(raw);
    const jobs   = this._get_enabled_jobs(config);

    this._validate_jobs(jobs);

    return jobs;
  }

  _parse_config(raw) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Cannot parse jobs config: ${error.message}`);
    }
  }

  _get_enabled_jobs(config) {
    if (!Array.isArray(config.jobs) || config.jobs.length === 0) {
      throw new Error('jobs.json must have a non-empty "jobs" array');
    }

    return config.jobs.filter(job => job.enabled !== false);
  }

  _validate_jobs(jobs) {
    for (const job of jobs) {
      this._validate_job(job);
    }
  }

  _validate_job(job) {
    if (!job.id)       throw new Error(`Job is missing "id": ${JSON.stringify(job)}`);
    if (!job.template) throw new Error(`Job "${job.id}" is missing "template"`);
    if (!job.output)   throw new Error(`Job "${job.id}" is missing "output"`);
    if (!job.format)   throw new Error(`Job "${job.id}" is missing "format"`);

    const output_ext = path.extname(job.output).toLowerCase();

    if (VIDEO_OUTPUT_EXTENSIONS.includes(output_ext) && !job.video) {
      throw new Error(`Job "${job.id}" outputs "${output_ext}" but is missing "video" config`);
    }

    if (job.video && !VIDEO_OUTPUT_EXTENSIONS.includes(output_ext)) {
      throw new Error(
        `Job "${job.id}" has "video" config, but output must be: ${VIDEO_OUTPUT_EXTENSIONS.join(', ')}`,
      );
    }
  }
}
