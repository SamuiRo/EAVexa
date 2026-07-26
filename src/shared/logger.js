import { LOG_FORMAT, LOG_LEVEL } from '../config/app_config.js';

// ─── Structured event logger ─────────────────────────────────────────────────
// Always writes to stderr — stdout is reserved for command results once the
// CLI (Крок 2) lands. `print()` in shared/utils.js remains the interactive
// stdout UX for the legacy batch runner and is unaffected by this module.

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function pretty_line(event) {
  const { level = 'info', msg, ...fields } = event;
  const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';

  return `[${level.toUpperCase()}] ${msg}${extra}`;
}

/**
 * Log a structured event: { level, msg, ...fields }.
 * `fields` typically includes request_id / job_id / render_id / phase / duration_ms.
 */
export function log(event) {
  const level = event.level ?? 'info';

  if (!log_level_enabled(level, LOG_LEVEL)) return;

  if (LOG_FORMAT === 'json') {
    console.error(JSON.stringify({ ts: new Date().toISOString(), ...event, level }));
    return;
  }

  console.error(pretty_line({ ...event, level }));
}

export function log_level_enabled(level, min_level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min_level];
}
