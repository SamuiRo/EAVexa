import { createReadStream } from 'fs';
import { read_json_body } from '../middleware/limits.js';
import { send_json } from '../middleware/errors.js';
import { resolve_public_base_url } from '../public_url.js';
import { normalize_request } from '../../core/render_request.js';

/**
 * POST /v1/render and POST /v1/templates/:name/render. Both funnel into the
 * same sync/async handling — see docs/specification.md §7.2-7.3.
 */
export default function register_render_routes(router, ctx) {
  router.post('/v1/render', (req, res) => handle(req, res, ctx, () => build_raw_request(req)));

  router.post('/v1/templates/:name/render', (req, res, params, url) => handle(req, res, ctx, () => build_template_raw_request(req, params, url)));
}

async function handle(req, res, ctx, build_raw) {
  const idempotency_key = req.headers['idempotency-key'];

  if (idempotency_key) {
    const cached = ctx.idempotency.get(idempotency_key);
    if (cached) return replay(res, cached, ctx);
  }

  const raw_request = await build_raw();
  const normalized = await normalize_request(raw_request, { registry: ctx.service.registry });

  if (normalized.mode === 'async') {
    const { job } = await ctx.service.submit(normalized, { normalized: true });
    const lane = normalized.video ? 'video' : 'image';
    const queue_position = ctx.service.queue.stats().queued[lane] ?? 0;

    const body = build_async_body(job, queue_position);
    if (idempotency_key) ctx.idempotency.set(idempotency_key, { kind: 'async', job_id: job.id });

    send_json(res, 202, body);
    return;
  }

  const result = await ctx.service.render(normalized, { normalized: true });
  await persist_sync_job_record(ctx.service, normalized, result);

  if (idempotency_key) {
    ctx.idempotency.set(idempotency_key, { kind: 'sync', result, output_type: normalized.output.type });
  }

  await respond_with_result(res, result, normalized.output.type);
}

async function replay(res, envelope, ctx) {
  if (envelope.kind === 'async') {
    const job = (await ctx.service.job_store.get(envelope.job_id)) ?? { id: envelope.job_id, status: 'unknown' };
    send_json(res, 202, build_async_body(job, 0));
    return;
  }

  await respond_with_result(res, envelope.result, envelope.output_type);
}

function build_async_body(job, queue_position) {
  return {
    ok: true,
    job_id: job.id,
    status: job.status,
    queue_position,
    estimate_ms: null, // no historical timing data to base an estimate on yet
    poll_url: `/v1/jobs/${job.id}`,
    result_url: `/v1/jobs/${job.id}/result`,
  };
}

async function persist_sync_job_record(service, normalized, result) {
  if (!service.job_store) return;

  await service.job_store.create({
    id: result.render_id,
    status: 'done',
    mode: 'sync',
    progress: { phase: 'done', current: 1, total: 1, ratio: 1 },
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    template: normalized.template?.name ?? null,
    type: result.type,
    metadata: result.metadata,
    result,
    error: null,
    callback: null,
  });
}

async function respond_with_result(res, result, output_type) {
  if (output_type === 'binary') {
    await new Promise((resolve, reject) => {
      res.writeHead(200, {
        'Content-Type': result.mime,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': String(result.bytes),
        'X-Render-Id': result.render_id,
        'X-Render-Width': String(result.width),
        'X-Render-Height': String(result.height),
        'X-Render-Duration-Ms': String(result.timings.total_ms),
        'X-Result-Path': result.path,
      });

      const stream = createReadStream(result.local_path);
      stream.on('error', reject);
      res.on('finish', resolve);
      stream.pipe(res);
    });
    return;
  }

  send_json(res, 200, { ok: true, result });
}

async function build_raw_request(req) {
  const body = await read_json_body(req);
  return { ...body, origin: { via: 'http', public_base_url: resolve_public_base_url(req) } };
}

async function build_template_raw_request(req, params, url) {
  const vars = await read_json_body(req);
  const query = url.searchParams;

  return {
    source: { name: params.name },
    vars,
    ...(query.has('format') ? { format: query.get('format') } : {}),
    ...(query.has('mode') ? { mode: query.get('mode') } : {}),
    ...(query.has('callback_url') ? { callback_url: query.get('callback_url') } : {}),
    ...(query.has('type') ? { output: { type: query.get('type') } } : {}),
    origin: { via: 'http', public_base_url: resolve_public_base_url(req) },
  };
}
