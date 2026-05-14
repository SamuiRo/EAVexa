import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

export const __dirname  = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR   = path.join(__dirname, '..', '..', 'data');
export const INPUTS_DIR = path.join(DATA_DIR, 'inputs');
export const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
export const JOBS_FILE  = path.join(DATA_DIR, 'jobs.json');