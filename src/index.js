import path             from 'path';
import { mkdirSync }    from 'fs';
import { readFile }     from 'fs/promises';
import ImageRenderer    from './modules/renderer/ImageRenderer.js';
import VideoRenderer    from './modules/renderer/video_renderer.js';
import { INPUTS_DIR, OUTPUT_DIR, JOBS_FILE } from './config/app_config.js';
import { print, banner } from './shared/utils.js';
import { WELCOME_MESSAGE, SUB_TITLE } from './shared/messages.js';

const VIDEO_OUTPUT_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv'];

// ─── Vexa ─────────────────────────────────────────────────────────────────────

class Vexa {
  constructor() {
    this.image_renderer = new ImageRenderer();
    this.video_renderer = new VideoRenderer();
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

      const output_ext = path.extname(job.output).toLowerCase();

      if (VIDEO_OUTPUT_EXTENSIONS.includes(output_ext) && !job.video) {
        throw new Error(`Job "${job.id}" outputs "${output_ext}" but is missing "video" config`);
      }

      if (job.video && !VIDEO_OUTPUT_EXTENSIONS.includes(output_ext)) {
        throw new Error(`Job "${job.id}" has "video" config, but output must be: ${VIDEO_OUTPUT_EXTENSIONS.join(', ')}`);
      }
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
        video:    job.video ?? null,
        opts:     job.opts ?? {},
      };
    });
  }

  split_render_jobs(render_jobs) {
    return {
      image_jobs: render_jobs.filter(job => !job.video),
      video_jobs: render_jobs.filter(job => job.video),
    };
  }

  // ─── Main ───────────────────────────────────────────────────────────────────

  async main() {
    try {
      banner(WELCOME_MESSAGE, SUB_TITLE);

      print('Loading jobs from data/jobs.json', 'system');
      const jobs = await this.load_jobs();
      print(`Found ${jobs.length} enabled job(s): ${jobs.map(j => j.id).join(', ')}`, 'data');

      const render_jobs = this.build_render_jobs(jobs);
      const { image_jobs, video_jobs } = this.split_render_jobs(render_jobs);
      const results = [];

      if (image_jobs.length > 0) {
        print('Connecting to browser for image jobs', 'system');
        await this.image_renderer.connect();

        print('Rendering images...', 'system');
        const image_results = await this.image_renderer.render_batch(image_jobs);
        results.push(...image_results);
      }

      if (video_jobs.length > 0) {
        print('Connecting to browser for video jobs', 'system');
        await this.video_renderer.connect();

        print('Rendering videos...', 'system');
        const video_results = await this.video_renderer.render_batch(video_jobs);
        results.push(...video_results);
      }

      for (const r of results) {
        const rel_output = path.relative(OUTPUT_DIR, r.output_path);
        if (r.type === 'video') {
          print(
            `${rel_output}  ->  ${r.width}x${r.height}px  @${r.dpr}x  ${r.frames} frames  ${r.fps}fps`,
            'success',
          );
          continue;
        }
        print(`${rel_output}  →  ${r.width}×${r.height}px  @${r.dpr}x`, 'success');
      }

      print('All jobs complete', 'success');
    } catch (err) {
      print(err.message, 'error');
      process.exit(1);
    } finally {
      await this.image_renderer.close();
      await this.video_renderer.close();
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const vexa = new Vexa();
vexa.main();
