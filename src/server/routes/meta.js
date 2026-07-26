import { createRequire } from 'module';
import { send_json } from '../middleware/errors.js';
import { FORMATS } from '../../config/render_config.js';
import { QUEUE_MAX } from '../../config/app_config.js';

const require = createRequire(import.meta.url);

function safe_version(module_path) {
  try {
    return require(module_path).version;
  } catch {
    return null;
  }
}

const VERSIONS = {
  eavexa: safe_version('../../../package.json'),
  node: process.version,
  playwright: safe_version('playwright/package.json'),
  ffmpeg_static: safe_version('ffmpeg-static/package.json'),
};

/**
 * GET /v1/formats, /v1/version, /healthz, /readyz — see docs/specification.md §7.1.
 */
export default function register_meta_routes(router, ctx) {
  router.get('/v1/formats', (req, res) => {
    const formats = Object.entries(FORMATS).map(([key, cfg]) => ({
      key, width: cfg.width, height: cfg.height, device_scale_factor: cfg.device_scale_factor, label: cfg.label,
    }));

    send_json(res, 200, { ok: true, formats });
  });

  router.get('/v1/version', (req, res) => {
    send_json(res, 200, { ok: true, ...VERSIONS });
  });

  router.get('/healthz', (req, res) => {
    send_json(res, 200, { ok: true });
  });

  router.get('/readyz', (req, res) => {
    // Simplified readiness: a browser that has never launched yet isn't
    // "dead", so the one cheap, unambiguous signal we check is queue
    // saturation. A deeper Chromium/FFmpeg liveness probe belongs to
    // `eavexa doctor`, which can afford to actually spawn processes.
    const stats = ctx.service.queue.stats();
    const lane_full = Object.keys(stats.queued).some(
      lane => (stats.queued[lane] ?? 0) + (stats.running[lane] ?? 0) >= QUEUE_MAX,
    );

    send_json(res, lane_full ? 503 : 200, { ok: !lane_full, queue: stats });
  });
}
