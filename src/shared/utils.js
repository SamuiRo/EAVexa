import chalk       from 'chalk';
import gradient    from 'gradient-string';
import fs          from 'fs/promises';
import path        from 'path';

// ─── Palette (NieR Automata inspired) ───────────────────────────────────────

const colors = {
  primary:          '#F4F4F4',
  secondary:        '#C0C0C0',
  dark:             '#1A1A1A',
  accent:           '#FFFFFF',
  dim:              '#808080',
  system_core_grey: '#B8B8B8',
  data:             '#A7D6D6',
  muted_amber:      '#CBBFA4',
  aqua_screen:      '#9CC4B2',
  pale_green:       '#8FA98F',
  dark_gray:        '#2E2E2E',
  silver:           '#A6A6A6',
  warm_white:       '#F2F2F2',
  red_alert:        '#A62626',
  cool_grey:        '#555555',
};

const symbols = {
  android:   '■',
  pod:       '●',
  data:      '◆',
  system:    '▲',
  warning:   '▼',
  error:     '✕',
  success:   '◉',
  info:      '○',
  loading:   '◐',
  separator: '│',
  corner:    '└',
  line:      '─',
};

// ─── Log type config ─────────────────────────────────────────────────────────

const LOG_TYPES = {
  info: {
    symbol:     symbols.info,
    label:      '[INFO]',
    labelColor: chalk.hex(colors.aqua_screen),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  system: {
    symbol:     symbols.system,
    label:      '[SYSTEM]',
    labelColor: chalk.hex(colors.system_core_grey),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  data: {
    symbol:     symbols.data,
    label:      '[DATA]',
    labelColor: chalk.hex(colors.data),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  warning: {
    symbol:     symbols.warning,
    label:      '[WARN]',
    labelColor: chalk.hex(colors.muted_amber),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  success: {
    symbol:     symbols.success,
    label:      '[OK]',
    labelColor: chalk.hex(colors.pale_green),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  debug: {
    symbol:     symbols.error,
    label:      '[DEBUG]',
    labelColor: chalk.hex(colors.red_alert),
    textColor:  chalk.hex(colors.system_core_grey),
  },
  error: {
    symbol:     symbols.error,
    label:      '[ERROR]',
    labelColor: chalk.hex(colors.red_alert),
    textColor:  chalk.hex(colors.system_core_grey),
  },
};

// ─── Logging ─────────────────────────────────────────────────────────────────

/**
 * Structured console logger.
 * @param {string} text
 * @param {'info'|'system'|'data'|'warning'|'success'|'debug'|'error'} type
 */
export function print(text, type = 'info') {
  const cfg       = LOG_TYPES[type] ?? LOG_TYPES.info;
  const timestamp = new Date().toISOString().replace('T', '_').substring(0, 19);
  const sep       = chalk.hex(colors.dim)(symbols.separator);
  const ts        = chalk.hex(colors.dim)(timestamp);

  console.log(
    `${cfg.symbol} ${sep} ${ts} ${sep} ${cfg.labelColor(cfg.label)} ${cfg.textColor(text)}`,
  );
}

/**
 * Print a styled banner with optional subtitle.
 */
export function banner(text, subtitle = null) {
  console.log('\n');
  console.log(
    gradient([colors.dark_gray, colors.silver, colors.warm_white])(text),
  );
  if (subtitle) console.log(chalk.hex(colors.cool_grey)(subtitle));
  console.log('\n');
}

/**
 * Print a section separator line, optionally centered on a label.
 * @param {string} [label]
 */
export function divider(label = '') {
  const width = 70;

  if (!label) {
    console.log(chalk.hex(colors.dim)(symbols.line.repeat(width)));
    return;
  }

  const text = ` ${label} `;
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  const right = Math.max(0, width - left - text.length);

  console.log(chalk.hex(colors.dim)(symbols.line.repeat(left) + text + symbols.line.repeat(right)));
}

// ─── Timing ──────────────────────────────────────────────────────────────────

/**
 * Async sleep.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Random delay in [min, max] range — adds human-like timing jitter.
 * @param {number} min_ms
 * @param {number} max_ms
 */
export function jitter(min_ms, max_ms) {
  const delay = Math.floor(Math.random() * (max_ms - min_ms + 1)) + min_ms;
  return sleep(delay);
}

/**
 * Time an async function. Does not swallow errors — a failed fn still throws.
 * @param {() => Promise<*>} fn
 * @returns {Promise<{ result: *, duration_ms: number }>}
 */
export async function measure(fn) {
  const start  = process.hrtime.bigint();
  const result = await fn();
  const duration_ms = Number(process.hrtime.bigint() - start) / 1e6;

  return { result, duration_ms };
}

/**
 * Retry an async function up to `attempts` times, waiting `delay_ms` between
 * tries. Throws the last error if every attempt fails.
 * @param {() => Promise<*>} fn
 * @param {number} [attempts]
 * @param {number} [delay_ms]
 */
export async function retry(fn, attempts = 3, delay_ms = 1000) {
  let last_error;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last_error = error;

      if (attempt < attempts) {
        await sleep(delay_ms);
      }
    }
  }

  throw last_error;
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

/**
 * Write JSON to file (overwrites). Throws on failure — callers decide how to
 * handle a broken write, it is never silently "successful".
 * @param {string} file_path
 * @param {*} data
 */
export async function save_json(file_path, data) {
  await fs.mkdir(path.dirname(file_path), { recursive: true });
  await fs.writeFile(file_path, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Read + parse JSON from file. Returns null if the file is missing or
 * unparsable — use this only where "no data yet" is a valid outcome.
 * @param {string} file_path
 * @returns {Promise<*|null>}
 */
export async function load_json(file_path) {
  try {
    const raw = await fs.readFile(file_path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write text to file (overwrites). Throws on failure.
 * @param {string} file_path
 * @param {string} text
 */
export async function save_txt(file_path, text) {
  await fs.mkdir(path.dirname(file_path), { recursive: true });
  await fs.writeFile(file_path, text, 'utf-8');
}

/**
 * Append a line of text to file (creates the file if missing). Throws on failure.
 * @param {string} file_path
 * @param {string} text
 */
export async function append_txt(file_path, text) {
  await fs.mkdir(path.dirname(file_path), { recursive: true });
  await fs.appendFile(file_path, text + '\n', 'utf-8');
}

/**
 * Check whether a path exists on disk.
 * @param {string} file_path
 * @returns {Promise<boolean>}
 */
export async function file_exists(file_path) {
  try {
    await fs.access(file_path);
    return true;
  } catch {
    return false;
  }
}

// ─── Collections ─────────────────────────────────────────────────────────────

/**
 * Split an array into chunks of size n (last chunk may be smaller).
 * @param {Array} array
 * @param {number} size
 * @returns {Array<Array>}
 */
export function chunk(array, size) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('chunk size must be a positive integer');
  }

  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
}

/**
 * Remove duplicate values from an array (preserves first-seen order).
 * @param {Array} array
 * @returns {Array}
 */
export function unique(array) {
  return [...new Set(array)];
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Format a byte count as a human-readable string. `1024 -> "1.0 KB"`.
 * @param {number} bytes
 * @returns {string}
 */
export function format_bytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

/**
 * Format a millisecond duration as a human-readable string. `90000 -> "1m 30s"`.
 * @param {number} ms
 * @returns {string}
 */
export function format_duration(ms) {
  const total_seconds = Math.floor(ms / 1000);
  const hours   = Math.floor(total_seconds / 3600);
  const minutes = Math.floor((total_seconds % 3600) / 60);
  const seconds = total_seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}
