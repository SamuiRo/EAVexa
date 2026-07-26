import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { send_json } from '../middleware/errors.js';
import { RenderError } from '../../core/errors.js';

/**
 * GET /v1/templates* — see docs/specification.md §7.6 and §9.1.
 */
export default function register_templates_routes(router, ctx) {
  router.get('/v1/templates', (req, res, params, url) => list_templates(url, ctx, res));
  router.get('/v1/templates/:name', (req, res, params) => show_template(params, ctx, res));
  router.get('/v1/templates/:name/preview', (req, res, params) => preview_template(params, ctx, res));
}

async function list_templates(url, ctx, res) {
  if (url.searchParams.get('refresh') === '1') {
    await ctx.service.registry.reload();
  }

  const templates = await ctx.service.registry.list({
    tag:  url.searchParams.get('tag') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
  });

  send_json(res, 200, { ok: true, templates });
}

async function show_template(params, ctx, res) {
  const manifest = await ctx.service.registry.get(params.name); // throws TEMPLATE_NOT_FOUND
  send_json(res, 200, { ok: true, template: manifest });
}

/**
 * Serves the template's static `preview.png` (a checked-in asset, per
 * docs/specification.md §9.1) — this is not a render, so there's nothing to
 * cache or compute.
 */
async function preview_template(params, ctx, res) {
  const resolved = await ctx.service.registry.resolve(params.name); // throws TEMPLATE_NOT_FOUND
  const preview_path = path.join(resolved.base_dir, 'preview.png');

  let file_stat;

  try {
    file_stat = await stat(preview_path);
  } catch {
    throw new RenderError('TEMPLATE_NOT_FOUND', `Template "${params.name}" has no preview.png`, { template: params.name });
  }

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': String(file_stat.size),
    'Cache-Control': 'public, max-age=86400',
  });

  createReadStream(preview_path).pipe(res);
}
