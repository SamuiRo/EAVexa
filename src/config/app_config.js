import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

export const __dirname  = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR   = path.join(__dirname, '..', '..', 'data');
export const INPUTS_DIR = path.join(DATA_DIR, 'inputs');
export const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
export const JOBS_FILE  = path.join(DATA_DIR, 'jobs.json');
export const CHROME_PATH   = process.env.CHROME_PATH ?? null;
export const CHROME_SANDBOX = process.env.CHROME_SANDBOX ?? 'auto'; // auto | on | off
export const FFMPEG_PATH   = process.env.FFMPEG_PATH ?? null;

export const NETWORK_TIMEOUT_MS = Number(process.env.NETWORK_TIMEOUT_MS ?? 15000);
export const FONT_TIMEOUT_MS    = Number(process.env.FONT_TIMEOUT_MS ?? 5000);
