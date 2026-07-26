import { createReadStream } from 'fs';
import { stat, rm } from 'fs/promises';
import { send_json } from '../middleware/errors.js';
import { RenderError } from '../../core/errors.js';
import { verify_result_token } from '../../core/result_token.js';
import { EAVEXA_API_KEY } from '../../config/app_config.js';

/**
 * GET/DELETE /v1/jobs* — see docs/specification.md §7.4-7.5.
 */
export default function register_jobs_routes(router, ctx) {
  router.get('/v1/jobs', (req, res, params, url) => list_jobs(req, res, url, ctx));
  router.get('/v1/jobs/:id', (req, res, params) => get_job(req, res, params, ctx));
  router.get('/v1/jobs/:id/result', (req, res, params, url) => stream_result(req, res, params, url, ctx));
  router.delete('/v1/jobs/:id', (req, res, params) => delete_job(req, res, params, ctx));
  router.post('/v1/jobs/:id/retry-callback', (req, res, params) => retry_callback(req, res, params, ctx));
}

async function list_jobs(req, res, url, ctx) {
  const query = url.searchParams;

  const jobs = await ctx.service.job_store.list({
    status: query.get('status') ?? undefined,
    before: query.get('before') ?? undefined,
    after:  query.get('after') ?? undefined,
    limit:  query.has('limit') ? Number(query.get('limit')) : 50,
  });

  send_json(res, 200, { ok: true, jobs });
}

async function get_job(req, res, params, ctx) {
  const job = await find_job(ctx, params.id);
  send_json(res, 200, { ok: true, job });
}

async function delete_job(req, res, params, ctx) {
  const job = await find_job(ctx, params.id);

  if (job.status === 'queued' || job.status === 'running') {
    const cancelled = await ctx.service.cancel(params.id);
    send_json(res, 200, { ok: true, job: cancelled });
    return;
  }

  if (job.result?.local_path) {
    await rm(job.result.local_path, { force: true });
    await rm(`${job.result.local_path}.meta.json`, { force: true });
  }

  await ctx.service.job_store.remove(params.id);
  send_json(res, 200, { ok: true, deleted: true, job_id: params.id });
}

async function retry_callback(req, res, params, ctx) {
  const job = await find_job(ctx, params.id);

  if (!job.callback) {
    throw new RenderError('INVALID_REQUEST', `Job "${params.id}" has no callback configured`, { job_id: params.id });
  }

  const event = job.status === 'done' ? 'render.completed' : 'render.failed';
  await ctx.service.notifier.notify(params.id, event, { force: true });

  send_json(res, 200, { ok: true, job: await ctx.service.job_store.get(params.id) });
}

async function find_job(ctx, id) {
  const job = await ctx.service.job_store.get(id);
  if (!job) throw new RenderError('JOB_NOT_FOUND', `Job "${id}" was not found`, { job_id: id });
  return job;
}

// ─── GET /v1/jobs/:id/result — streamed, Range/ETag/304-aware ──────────────

async function stream_result(req, res, params, url, ctx) {
  const job = await find_job(ctx, params.id);

  check_result_auth(req, url, job.id);

  if (!job.result) {
    throw new RenderError('JOB_NOT_FOUND', `Job "${params.id}" has no result yet (status: ${job.status})`, {
      job_id: params.id, status: job.status,
    });
  }

  const file_path = job.result.local_path;
  let file_stat;

  try {
    file_stat = await stat(file_path);
  } catch {
    throw new RenderError('RESULT_GONE', `Result for job "${params.id}" is no longer on disk`, { job_id: params.id });
  }

  const etag = `"${job.result.checksum.replace('sha256:', '')}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  const base_headers = {
    'Content-Type': job.result.mime,
    'Content-Disposition': `inline; filename="${job.result.filename}"`,
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0',
  };

  const range = parse_range(req.headers.range, file_stat.size);

  if (req.headers.range && !range) {
    res.writeHead(416, { 'Content-Range': `bytes */${file_stat.size}` });
    res.end();
    return;
  }

  if (range) {
    res.writeHead(206, {
      ...base_headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${file_stat.size}`,
      'Content-Length': String(range.end - range.start + 1),
    });
    createReadStream(file_path, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...base_headers, 'Content-Length': String(file_stat.size) });
  createReadStream(file_path).pipe(res);
}

function check_result_auth(req, url, job_id) {
  if (!EAVEXA_API_KEY) return;

  const key_ok = req.headers['x-api-key'] === EAVEXA_API_KEY;
  const token_ok = verify_result_token(job_id, url.searchParams.get('token'));

  if (!key_ok && !token_ok) {
    throw new RenderError('UNAUTHORIZED', 'Missing or invalid X-API-Key (or ?token=)');
  }
}

function parse_range(header, size) {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;

  const start = match[1] ? Number(match[1]) : size - Number(match[2]);
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) return null;

  return { start, end };
}
