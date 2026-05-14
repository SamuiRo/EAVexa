import path             from 'path';
import { mkdirSync }    from 'fs';
import { readFile }     from 'fs/promises';
import ImageRenderer    from './modules/renderer/ImageRenderer.js';
import { INPUTS_DIR, OUTPUT_DIR, JOBS_FILE } from './config/app_config.js';
import { print, banner } from './shared/utils.js';
import { WELCOME_MESSAGE, SUB_TITLE } from './shared/messages.js';

// ─── Vexa ─────────────────────────────────────────────────────────────────────

class Vexa {
  constructor() {
    this.renderer = new ImageRenderer();
  }

  // ─── Load and validate jobs config ──────────────────────────────────────────

  async load_jobs() {
    let raw;
    try {
      raw = await readFile(JOBS_FILE, 'utf-8');
    } catch {
      throw new Error(`Cannot read jobs config: ${JOBS_FILE}`);
    }

    const config = JSON.parse(raw);

    if (!Array.isArray(config.jobs) || config.jobs.length === 0) {
      throw new Error('jobs.json must have a non-empty "jobs" array');
    }

    const jobs = config.jobs.filter(job => job.enabled !== false);

    for (const job of jobs) {
      if (!job.id)       throw new Error(`Job is missing "id": ${JSON.stringify(job)}`);
      if (!job.template) throw new Error(`Job "${job.id}" is missing "template"`);
      if (!job.output)   throw new Error(`Job "${job.id}" is missing "output"`);
      if (!job.format)   throw new Error(`Job "${job.id}" is missing "format"`);
    }

    return jobs;
  }

  // ─── Build renderer jobs from config ────────────────────────────────────────

  build_render_jobs(jobs) {
    return jobs.map(job => {
      const job_input_dir  = path.join(INPUTS_DIR, job.id);
      const job_output_dir = path.join(OUTPUT_DIR, job.id);

      mkdirSync(job_output_dir, { recursive: true });

      return {
        template: path.join(job_input_dir, job.template),
        output:   path.join(job_output_dir, job.output),
        format:   job.format,
        vars:     job.vars ?? {},
      };
    });
  }

  // ─── Main ───────────────────────────────────────────────────────────────────

  async main() {
    try {
      banner(WELCOME_MESSAGE, SUB_TITLE);

      print('Loading jobs from data/jobs.json', 'system');
      const jobs = await this.load_jobs();
      print(`Found ${jobs.length} enabled job(s): ${jobs.map(j => j.id).join(', ')}`, 'data');

      const render_jobs = this.build_render_jobs(jobs);

      print('Connecting to browser', 'system');
      await this.renderer.connect();

      print('Rendering...', 'system');
      const results = await this.renderer.render_batch(render_jobs);

      for (const r of results) {
        const rel_output = path.relative(OUTPUT_DIR, r.output_path);
        print(`${rel_output}  →  ${r.width}×${r.height}px  @${r.dpr}x`, 'success');
      }

      print('All jobs complete', 'success');
    } catch (err) {
      print(err.message, 'error');
      process.exit(1);
    } finally {
      await this.renderer.close();
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const vexa = new Vexa();
vexa.main();