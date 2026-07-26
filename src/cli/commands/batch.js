import { parse_args } from '../args.js';
import { create_output } from '../output.js';
import { create_render_service } from '../../core/create_render_service.js';
import JobLoader from '../../modules/jobs/job_loader.js';
import RenderJobBuilder from '../../modules/jobs/render_job_builder.js';
import RenderOrchestrator from '../../modules/orchestrator/render_orchestrator.js';
import RenderResultReporter from '../../modules/orchestrator/render_result_reporter.js';
import { RenderError } from '../../core/errors.js';
import { WELCOME_MESSAGE, SUB_TITLE } from '../../shared/messages.js';

const BOOLEANS = ['json', 'quiet', 'verbose', 'help'];
const ALIASES = { h: 'help' };

const HELP = `Usage: eavexa batch [options]

Render every enabled job in data/jobs.json (the legacy batch workflow).

Options:
      --jobs <path>   Path to the jobs config (default: data/jobs.json)
      --json          Print one JSON result line to stdout
      --quiet         Suppress informational output
      --verbose       Show debug-level output`;

export default async function batch_command(argv) {
  const args = parse_args(argv, { aliases: ALIASES, booleans: BOOLEANS });

  if (args.help) {
    console.log(HELP);
    return;
  }

  const output = create_output({ json: !!args.json, quiet: !!args.quiet, verbose: !!args.verbose });
  const job_loader = new JobLoader(args.jobs ? { jobs_file: args.jobs } : {});
  const render_job_builder = new RenderJobBuilder();
  const reporter = new RenderResultReporter();
  const orchestrator = new RenderOrchestrator({ render_service: create_render_service() });

  try {
    output.show_banner(WELCOME_MESSAGE, SUB_TITLE);

    output.info('Loading jobs from data/jobs.json');
    const jobs = await job_loader.load_jobs();
    output.info(`Found ${jobs.length} enabled job(s): ${jobs.map(job => job.id).join(', ')}`);

    const render_jobs = render_job_builder.build_render_jobs(jobs);
    const results = await orchestrator.render(render_jobs);

    if (output.json) {
      output.result({ ok: true, results });
    } else {
      reporter.print_results(results);
      output.success('All jobs complete');
    }
  } catch (error) {
    output.error(error);
    process.exitCode = error instanceof RenderError ? error.exit_code : 1;
  } finally {
    await orchestrator.close();
  }
}
