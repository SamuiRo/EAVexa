import { RenderError } from '../../core/errors.js';

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {Object} payload
 */
export function send_json(res, status, payload) {
  if (res.headersSent) return;

  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Maps any thrown error to the §7.7 error envelope. Non-RenderErrors are
 * treated as INTERNAL rather than leaking implementation details.
 */
export function send_error(res, error, request_id) {
  const render_error = error instanceof RenderError ? error : new RenderError('INTERNAL', error.message);

  send_json(res, render_error.http_status ?? 500, {
    ok: false,
    error: {
      code: render_error.code,
      message: render_error.message,
      details: render_error.details,
      request_id,
    },
  });
}
