import JobLoader            from './modules/jobs/job_loader.js';
import RenderJobBuilder     from './modules/jobs/render_job_builder.js';
import RenderOrchestrator   from './modules/orchestrator/render_orchestrator.js';
import RenderResultReporter from './modules/orchestrator/render_result_reporter.js';
import RenderService        from './core/render_service.js';
import TemplateRegistry     from './core/template_registry.js';
import BrowserPool          from './core/browser_pool.js';
import RenderQueue          from './core/render_queue.js';
import StorageAdapter       from './core/storage_adapter.js';
import { BUILTIN_TEMPLATES_DIR, TEMPLATES_DIR } from './config/app_config.js';
import { print, banner }    from './shared/utils.js';
import { WELCOME_MESSAGE, SUB_TITLE } from './shared/messages.js';

/**
 * Main application orchestrator.
 */
class Vexa {
  constructor() {
    const registry = new TemplateRegistry({
      builtin_dir: BUILTIN_TEMPLATES_DIR,
      user_dir:    TEMPLATES_DIR,
    });
    const pool     = new BrowserPool();
    const queue    = new RenderQueue();
    const storage  = new StorageAdapter();

    const render_service = new RenderService({ registry, pool, queue, storage });

    this.job_loader             = new JobLoader();
    this.render_job_builder     = new RenderJobBuilder();
    this.render_orchestrator    = new RenderOrchestrator({ render_service });
    this.render_result_reporter = new RenderResultReporter();
  }

  async main() {
    try {
      banner(WELCOME_MESSAGE, SUB_TITLE);

      print('Loading jobs from data/jobs.json', 'system');
      const jobs = await this.job_loader.load_jobs();
      print(`Found ${jobs.length} enabled job(s): ${jobs.map(job => job.id).join(', ')}`, 'data');

      const render_jobs = this.render_job_builder.build_render_jobs(jobs);
      const results     = await this.render_orchestrator.render(render_jobs);

      this.render_result_reporter.print_results(results);

      print('All jobs complete', 'success');
    } catch (error) {
      print(error.message, 'error');
      process.exitCode = 1;
    } finally {
      await this.render_orchestrator.close();
    }
  }
}

const vexa = new Vexa();
await vexa.main();
