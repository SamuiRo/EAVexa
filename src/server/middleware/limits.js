import { RenderError } from '../../core/errors.js';
import { MAX_BODY_MB } from '../../config/app_config.js';

const MAX_BODY_BYTES = MAX_BODY_MB * 1024 * 1024;

/**
 * Reads the full request body, rejecting with PAYLOAD_TOO_LARGE once
 * MAX_BODY_MB is exceeded rather than buffering an unbounded body.
 */
export function read_body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;

    req.on('data', chunk => {
      if (rejected) return;

      total += chunk.length;

      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new RenderError('PAYLOAD_TOO_LARGE', `Request body exceeds MAX_BODY_MB (${MAX_BODY_MB}MB)`));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

export async function read_json_body(req) {
  const buffer = await read_body(req);
  if (buffer.length === 0) return {};

  try {
    return JSON.parse(buffer.toString('utf-8'));
  } catch (error) {
    throw new RenderError('INVALID_REQUEST', `Request body is not valid JSON: ${error.message}`);
  }
}
