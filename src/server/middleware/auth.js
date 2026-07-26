import { RenderError } from '../../core/errors.js';
import { EAVEXA_API_KEY } from '../../config/app_config.js';

const ALWAYS_OPEN = new Set(['/healthz', '/readyz']);
// GET /v1/jobs/:id/result supports its own ?token= auth (see routes/jobs.js)
// instead of the main API key — skip the blanket check for it here.
const CUSTOM_AUTH = /^\/v1\/jobs\/[^/]+\/result$/;

/**
 * Throws UNAUTHORIZED unless the request carries a matching X-API-Key.
 * No-op entirely when EAVEXA_API_KEY isn't set — open access is a documented
 * trade-off for localhost-only deployments (docs/api.md).
 */
export function check_auth(req, pathname) {
  if (!EAVEXA_API_KEY) return;
  if (ALWAYS_OPEN.has(pathname) || CUSTOM_AUTH.test(pathname)) return;

  if (req.headers['x-api-key'] !== EAVEXA_API_KEY) {
    throw new RenderError('UNAUTHORIZED', 'Missing or invalid X-API-Key');
  }
}
