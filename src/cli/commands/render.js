import { readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import path from 'path';
import { parse_args, as_array } from '../args.js';
import { create_output } from '../output.js';
import { create_render_service } from '../../core/create_render_service.js';
import { normalize_request } from '../../core/render_request.js';
import { RenderError } from '../../core/errors.js';
import { format_bytes } from '../../shared/utils.js';

const BOOLEANS = [
  'json', 'quiet', 'verbose', 'stdin', 'offline', 'strict-assets',
  'keep-frames', 'watch', 'open', 'dry-run', 'help',
];
const ALIASES = { t: 'template', f: 'format', o: 'out', h: 'help' };

const HELP = `Usage: eavexa render [options]

Render a single template to an image or video.

Source (exactly one):
  -t, --template <name>       Template from the registry
      --file <path>           HTML file on disk
      --url <url>             Remote HTML document
      --stdin                 Read HTML from stdin
      --request <path|->      Full JSON request (same contract as the HTTP API)

Options:
  -f, --format <key|WxH[@dpr]>  e.g. "story" or "1080x1920@2"
      --var K=V                 Template variable (repeatable)
      --vars-file <path>        JSON file of variables
      --video-duration <sec>    Enables video mode
      --fps <n>  --crf <n>  --preset <name>  --keep-frames
  -o, --out <path|->           Output path, or "-" for stdout
      --offline                 Block all external network requests
      --strict-assets           Fail the render if any asset fails to load
      --timeout <ms>            Override the render timeout
      --callback-url <url>      Render as an async job; POST the result here when done
      --callback-header K=V     Extra header on the callback request (repeatable)
      --json                    Print one JSON result line to stdout
      --quiet                   Suppress informational output
      --verbose                 Show debug-level output
      --dry-run                 Print the normalized request, render nothing
      --watch                   Re-render when --file changes
      --open                    Open the result with the OS default handler

Examples:
  eavexa render -t story_pricing_pro --var TITLE="Launch week" -o ./out.png
  eavexa render --file ./my.html --format story -o ./out.png
  cat my.html | eavexa render --stdin --format story -o - > out.png
  eavexa render -t promo --video-duration 8 --fps 30 -o ./promo.mp4
  eavexa render -t promo --video-duration 30 -o ./promo.mp4 \\
                --callback-url http://localhost:5678/webhook/eavexa-done

Note: --callback-url keeps this process alive until the render (and the
first webhook delivery attempt) finish — there is no background daemon yet
(that lands with the HTTP server in Крок 4). A failed delivery still
schedules a retry durably in the job store, resumed the next time any
"eavexa" command runs and calls RenderService.start().`;

export default async function render_command(argv) {
  const args = parse_args(argv, { aliases: ALIASES, booleans: BOOLEANS });

  if (args.help) {
    console.log(HELP);
    return;
  }

  const raw_stdout = args.out === '-';
  const output = create_output({ json: !!args.json, quiet: !!args.quiet, verbose: !!args.verbose, raw_stdout });

  let raw_request;

  try {
    raw_request = args.request
      ? await load_request_document(args.request)
      : await build_request_from_flags(args);
  } catch (error) {
    output.error(error);
    process.exitCode = error instanceof RenderError ? error.exit_code : 2;
    return;
  }

  if (args['dry-run']) {
    await run_dry_run(raw_request, output);
    return;
  }

  if (args.watch) {
    await run_watch(raw_request, args, output);
    return;
  }

  await run_single(raw_request, args, output, raw_stdout);
}

// ─── Modes ────────────────────────────────────────────────────────────────

async function run_single(raw_request, args, output, raw_stdout) {
  const service = create_render_service();
  await service.start();

  try {
    if (raw_request.callback_url) {
      await run_async(service, raw_request, output);
      return;
    }

    output.info('Rendering...');
    const result = await service.render(raw_request, {});

    await deliver_result(result, output, raw_stdout);

    if (args.open) await open_path(result.local_path);
  } catch (error) {
    output.error(error);
    process.exitCode = error instanceof RenderError ? error.exit_code : 1;
  } finally {
    await service.close();
  }
}

/**
 * --callback-url path: submit as a durable job, wait for it (and the first
 * webhook attempt) to settle, then report the final job record. The process
 * intentionally stays alive for this — see the note in HELP above.
 */
async function run_async(service, raw_request, output) {
  const { job, done } = await service.submit(raw_request);
  output.info(`Job ${job.id} queued (async) — will POST to ${raw_request.callback_url} on completion.`);

  await done;
  const final = await service.job_store.get(job.id);

  if (final.status === 'done') {
    output.success(summarize(final.result));
    output.result(final);
    return;
  }

  const error = new RenderError(final.error?.code ?? 'INTERNAL', final.error?.message ?? 'Job failed', final.error?.details);
  output.error(error);
  output.result(final);
  process.exitCode = error.exit_code;
}

async function run_dry_run(raw_request, output) {
  const service = create_render_service();

  try {
    const normalized = await normalize_request(raw_request, { registry: service.registry });

    if (!output.json) output.info('Dry run — normalized request:');
    process.stdout.write(`${JSON.stringify(normalized, null, output.json ? 0 : 2)}\n`);
  } catch (error) {
    output.error(error);
    process.exitCode = error instanceof RenderError ? error.exit_code : 2;
  } finally {
    await service.close();
  }
}

async function run_watch(raw_request, args, output) {
  if (!args.file) {
    const error = new RenderError('INVALID_REQUEST', '--watch requires --file <path>');
    output.error(error);
    process.exitCode = error.exit_code;
    return;
  }

  const { watch } = await import('fs');
  const service = create_render_service();
  await service.start();
  let opened = false;
  let rendering = false;
  let pending = false;

  const render_once = async () => {
    if (rendering) { pending = true; return; }
    rendering = true;

    try {
      output.info(`Rendering ${path.basename(args.file)}...`);
      const result = await service.render(raw_request, {});
      output.success(summarize(result));

      if (args.open && !opened) {
        opened = true;
        await open_path(result.local_path);
      }
    } catch (error) {
      output.error(error);
    } finally {
      rendering = false;
      if (pending) { pending = false; await render_once(); }
    }
  };

  await render_once();
  output.info(`Watching ${args.file} for changes — press Ctrl+C to stop.`);
  watch(path.resolve(args.file), { persistent: true }, () => { render_once(); });

  await new Promise(() => {}); // keep the process alive; Ctrl+C exits
}

// ─── Request building ───────────────────────────────────────────────────────

async function build_request_from_flags(args) {
  return {
    source:  await resolve_source(args),
    format:  args.format,
    vars:    await resolve_vars(args),
    video:   build_video(args),
    output:  build_output(args),
    options: {
      offline:       !!args.offline,
      strict_assets: !!args['strict-assets'],
      ...(args.timeout !== undefined ? { timeout_ms: Number(args.timeout) } : {}),
    },
    ...(args['callback-url'] ? {
      callback_url: args['callback-url'],
      callback_headers: build_callback_headers(args),
    } : {}),
  };
}

function build_callback_headers(args) {
  const headers = {};

  for (const entry of as_array(args['callback-header'])) {
    const eq_index = entry.indexOf('=');

    if (eq_index === -1) {
      throw new RenderError('INVALID_REQUEST', `Invalid --callback-header "${entry}", expected KEY=VALUE`);
    }

    headers[entry.slice(0, eq_index)] = entry.slice(eq_index + 1);
  }

  return headers;
}

async function resolve_source(args) {
  const provided = ['template', 'file', 'url', 'stdin'].filter(key => args[key] !== undefined);

  if (provided.length !== 1) {
    throw new RenderError('INVALID_REQUEST', 'Exactly one of --template, --file, --url, --stdin is required');
  }

  if (args.template) return { name: args.template };
  if (args.file) return { path: path.resolve(args.file) };
  if (args.url) return { url: args.url };

  return { html: await read_stdin() };
}

async function resolve_vars(args) {
  const vars = {};

  if (args['vars-file']) {
    Object.assign(vars, JSON.parse(await readFile(args['vars-file'], 'utf-8')));
  }

  for (const entry of as_array(args.var)) {
    const eq_index = entry.indexOf('=');

    if (eq_index === -1) {
      throw new RenderError('INVALID_REQUEST', `Invalid --var "${entry}", expected KEY=VALUE`);
    }

    vars[entry.slice(0, eq_index)] = entry.slice(eq_index + 1);
  }

  return vars;
}

function build_video(args) {
  if (args['video-duration'] === undefined) return undefined;

  return {
    duration: Number(args['video-duration']),
    ...(args.fps !== undefined ? { fps: Number(args.fps) } : {}),
    ...(args.crf !== undefined ? { crf: Number(args.crf) } : {}),
    ...(args.preset !== undefined ? { preset: args.preset } : {}),
    keep_frames: !!args['keep-frames'],
  };
}

function build_output(args) {
  if (!args.out || args.out === '-') return undefined; // default managed OUTPUT_DIR location

  const abs = path.resolve(args.out);
  return { filename: path.basename(abs), dir: path.dirname(abs) };
}

async function load_request_document(source) {
  const raw = source === '-' ? await read_stdin() : await readFile(source, 'utf-8');

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RenderError('INVALID_REQUEST', `--request document is not valid JSON: ${error.message}`);
  }
}

function read_stdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

// ─── Result delivery ────────────────────────────────────────────────────────

async function deliver_result(result, output, raw_stdout) {
  if (raw_stdout) {
    await pipeline(createReadStream(result.local_path), process.stdout);
    return;
  }

  if (output.json) {
    output.result(result);
    return;
  }

  output.success(summarize(result));
  output.info(`Saved to ${result.local_path}`);
}

function summarize(result) {
  const dims = `${result.width}x${result.height}px`;
  const extra = result.frames ? `  ${result.frames} frames  ${result.fps}fps` : '';
  return `${result.filename}  ->  ${dims}${extra}  (${format_bytes(result.bytes)})`;
}

async function open_path(target_path) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', target_path], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [target_path], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [target_path], { detached: true, stdio: 'ignore' }).unref();
  }
}
