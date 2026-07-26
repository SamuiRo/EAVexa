import { createHmac, timingSafeEqual } from 'crypto';
import { RESULT_TOKEN_SECRET } from '../config/app_config.js';

// ─── Signed one-time result links ────────────────────────────────────────────
// `GET /v1/jobs/:id/result?token=...` lets a link be shared without the main
// X-API-Key. Gated on RESULT_TOKEN_SECRET — with no secret configured, no
// token ever verifies, so `?token=` has no effect and the main auth applies.

/**
 * @param {string} job_id
 * @param {number} [ttl_ms] Default 1 hour.
 * @param {string|null} [secret]
 * @returns {string|null} `<expires_at>.<hmac>`, or null if no secret is configured.
 */
export function sign_result_token(job_id, ttl_ms = 3600000, secret = RESULT_TOKEN_SECRET) {
  if (!secret) return null;

  const expires_at = Date.now() + ttl_ms;
  const signature = createHmac('sha256', secret).update(`${job_id}.${expires_at}`).digest('hex');

  return `${expires_at}.${signature}`;
}

/**
 * @param {string} job_id
 * @param {string|undefined} token
 * @param {string|null} [secret]
 * @returns {boolean}
 */
export function verify_result_token(job_id, token, secret = RESULT_TOKEN_SECRET) {
  if (!secret || !token) return false;

  const [expires_at_raw, signature] = token.split('.');
  const expires_at = Number(expires_at_raw);
  if (!Number.isFinite(expires_at) || !signature) return false;
  if (Date.now() > expires_at) return false;

  const expected = createHmac('sha256', secret).update(`${job_id}.${expires_at}`).digest('hex');
  const expected_buf = Buffer.from(expected, 'hex');
  const actual_buf = Buffer.from(signature, 'hex');

  return expected_buf.length === actual_buf.length && timingSafeEqual(expected_buf, actual_buf);
}
