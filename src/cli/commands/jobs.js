import { rm } from 'fs/promises';
import { parse_args } from '../args.js';
import { create_output } from '../output.js';
import { create_render_service } from '../../core/create_render_service.js';
import { RenderError } from '../../core/errors.js';
import { format_bytes } from '../../shared/utils.js';

const BOOLEANS = ['json', 'dry-run', 'help'];
const ALIASES = { h: 'help' };

const HELP = `Usage: eavexa jobs <list|show|cancel|prune|stats> [options]

  list [--status s] [--limit n]     List jobs, newest first
  show <id>                         Print one job's full record
  cancel <id>                       Cancel a queued/running job (same-process only — see note below)
  prune [--older-than 30d] [--status s] [--keep-last n] [--dry-run]
                                     Delete old job records + note their result files stay on disk
  stats                             Counts by status, total result bytes

Options:
      --json    Print machine-readable JSON instead of a human table

Note: "cancel" can only interrupt a job that is still running in the very
same OS process — there is no cross-process signaling until the HTTP server
(Крок 4) holds all job state in one place. Against a job from another
process, it just marks the stored record cancelled without stopping the render.`;

export default async function jobs_command(argv) {
  const [subcommand, ...rest] = argv;
  const args = parse_args(rest, { aliases: ALIASES, booleans: BOOLEANS });

  if (args.help || !subcommand) {
    console.log(HELP);
    return;
  }

  const output = create_output({ json: !!args.json });
  const service = create_render_service();

  try {
    if (subcommand === 'list') return await list_jobs(service, args, output);
    if (subcommand === 'show') return await show_job(service, args._[0], output);
    if (subcommand === 'cancel') return await cancel_job(service, args._[0], output);
    if (subcommand === 'prune') return await prune_jobs(service, args, output);
    if (subcommand === 'stats') return await show_stats(service, output);

    throw new RenderError('INVALID_REQUEST', `Unknown "jobs" subcommand "${subcommand}". Use list, show, cancel, prune, or stats.`);
  } catch (error) {
    output.error(error);
    process.exitCode = error instanceof RenderError ? error.exit_code : 1;
  }
}

async function list_jobs(service, args, output) {
  const jobs = await service.job_store.list({
    status: args.status,
    limit: args.limit ? Number(args.limit) : 50,
  });

  if (output.json) {
    output.result(jobs);
    return;
  }

  if (jobs.length === 0) {
    output.info('No jobs found.');
    return;
  }

  for (const job of jobs) {
    output.success(`${job.id}  ${job.status.padEnd(9)}  ${job.type ?? '?'}  ${job.template ?? '(inline/file)'}  ${job.created_at}`);
  }
}

async function show_job(service, id, output) {
  if (!id) throw new RenderError('INVALID_REQUEST', 'Usage: eavexa jobs show <id>');

  const job = await service.job_store.get(id);
  if (!job) throw new RenderError('JOB_NOT_FOUND', `Job "${id}" was not found`, { job_id: id });

  console.log(JSON.stringify(job, null, output.json ? 0 : 2));
}

async function cancel_job(service, id, output) {
  if (!id) throw new RenderError('INVALID_REQUEST', 'Usage: eavexa jobs cancel <id>');

  const job = await service.cancel(id);

  if (output.json) {
    output.result(job);
  } else {
    output.success(`Job ${job.id} is now "${job.status}".`);
  }
}

async function prune_jobs(service, args, output) {
  const dry_run = !!args['dry-run'];
  const all = await service.job_store.list({ status: args.status, limit: Infinity });

  let candidates = all;

  if (args['older-than']) {
    const cutoff = Date.now() - parse_duration(args['older-than']);
    candidates = candidates.filter(job => new Date(job.finished_at ?? job.created_at).getTime() < cutoff);
  }

  if (args['keep-last']) {
    // `all`/`candidates` are newest-first — keep the newest N, prune the rest.
    const keep_ids = new Set(all.slice(0, Number(args['keep-last'])).map(job => job.id));
    candidates = candidates.filter(job => !keep_ids.has(job.id));
  }

  if (!dry_run) {
    for (const job of candidates) {
      if (job.result?.local_path) {
        await rm(job.result.local_path, { force: true });
        await rm(`${job.result.local_path}.meta.json`, { force: true });
      }

      await service.job_store.remove(job.id);
    }
  }

  if (output.json) {
    output.result({ ok: true, dry_run, pruned: candidates.length, job_ids: candidates.map(job => job.id) });
    return;
  }

  output.success(`${dry_run ? 'Would prune' : 'Pruned'} ${candidates.length} job record(s) and their result files.`);
}

async function show_stats(service, output) {
  const all = await service.job_store.list({ limit: Infinity });
  const by_status = {};
  let total_bytes = 0;

  for (const job of all) {
    by_status[job.status] = (by_status[job.status] ?? 0) + 1;
    if (job.result?.bytes) total_bytes += job.result.bytes;
  }

  const stats = { total: all.length, by_status, total_bytes };

  if (output.json) {
    output.result(stats);
    return;
  }

  output.success(`${stats.total} job(s) total, ${format_bytes(stats.total_bytes)} of results`);
  for (const [status, count] of Object.entries(by_status)) {
    output.info(`  ${status.padEnd(9)} ${count}`);
  }
}

function parse_duration(text) {
  const match = /^(\d+)(s|m|h|d)$/.exec(text);
  if (!match) throw new RenderError('INVALID_REQUEST', `Invalid duration "${text}", expected e.g. "30d", "12h", "45m"`);

  const [, amount, unit] = match;
  const unit_ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];

  return Number(amount) * unit_ms;
}
