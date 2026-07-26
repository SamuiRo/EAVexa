import 'dotenv/config';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

export const __dirname  = path.dirname(fileURLToPath(import.meta.url));

// ─── Paths ───────────────────────────────────────────────────────────────────

export const DATA_DIR   = process.env.DATA_DIR ?? path.join(__dirname, '..', '..', 'data');
export const INPUTS_DIR = path.join(DATA_DIR, 'inputs');
export const JOBS_FILE  = path.join(DATA_DIR, 'jobs.json');

export const OUTPUT_DIR       = process.env.OUTPUT_DIR ?? path.join(DATA_DIR, 'outputs');
export const OUTPUT_DIR_ALIAS = process.env.OUTPUT_DIR_ALIAS ?? null;

export const BUILTIN_TEMPLATES_DIR = process.env.BUILTIN_TEMPLATES_DIR
  ?? path.join(__dirname, '..', '..', 'templates');
export const TEMPLATES_DIR = process.env.TEMPLATES_DIR ?? path.join(DATA_DIR, 'templates');

export const TMP_DIR = process.env.TMP_DIR ?? os.tmpdir();

export const JOB_STORE_DIR = process.env.JOB_STORE_DIR ?? path.join(DATA_DIR, 'jobs');
export const JOB_CACHE_SIZE = Number(process.env.JOB_CACHE_SIZE ?? 500);

// ─── Chromium / FFmpeg ───────────────────────────────────────────────────────

export const CHROME_PATH    = process.env.CHROME_PATH ?? null;
export const CHROME_SANDBOX = process.env.CHROME_SANDBOX ?? 'auto'; // auto | on | off
export const FFMPEG_PATH    = process.env.FFMPEG_PATH ?? null;

export const NETWORK_TIMEOUT_MS = Number(process.env.NETWORK_TIMEOUT_MS ?? 15000);
export const FONT_TIMEOUT_MS    = Number(process.env.FONT_TIMEOUT_MS ?? 5000);

export const BROWSER_MAX_RENDERS = Number(process.env.BROWSER_MAX_RENDERS ?? 200);

// ─── Render limits ───────────────────────────────────────────────────────────

export const MAX_WIDTH          = Number(process.env.MAX_WIDTH ?? 4096);
export const MAX_HEIGHT         = Number(process.env.MAX_HEIGHT ?? 4096);
export const MAX_VIDEO_DURATION = Number(process.env.MAX_VIDEO_DURATION ?? 60);
export const MAX_FPS            = Number(process.env.MAX_FPS ?? 60);
export const MAX_FRAMES         = Number(process.env.MAX_FRAMES ?? 3600);

export const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 60000);
export const SYNC_MAX_COST     = Number(process.env.SYNC_MAX_COST ?? 90);

// ─── Queue ───────────────────────────────────────────────────────────────────

export const RENDER_CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 3);
export const VIDEO_CONCURRENCY  = Number(process.env.VIDEO_CONCURRENCY ?? 1);
export const QUEUE_MAX          = Number(process.env.QUEUE_MAX ?? 100);

// ─── Templates ───────────────────────────────────────────────────────────────

export const TEMPLATE_ALLOWED_HOSTS = process.env.TEMPLATE_ALLOWED_HOSTS
  ? process.env.TEMPLATE_ALLOWED_HOSTS.split(',').map(host => host.trim())
  : null;

// ─── Webhooks ────────────────────────────────────────────────────────────────

export const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET ?? null;
export const WEBHOOK_MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5);
export const WEBHOOK_TIMEOUT_MS   = Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10000);
export const WEBHOOK_ALLOW_PRIVATE = (process.env.WEBHOOK_ALLOW_PRIVATE ?? 'true') === 'true';
export const WEBHOOK_ALLOWED_HOSTS = process.env.WEBHOOK_ALLOWED_HOSTS
  ? process.env.WEBHOOK_ALLOWED_HOSTS.split(',').map(host => host.trim())
  : null;

// ─── Logging ─────────────────────────────────────────────────────────────────

export const LOG_FORMAT = process.env.LOG_FORMAT ?? 'pretty'; // pretty | json
export const LOG_LEVEL  = process.env.LOG_LEVEL ?? 'info';
