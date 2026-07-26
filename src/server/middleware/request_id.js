import { new_request_id } from '../../core/ids.js';

/**
 * Every response carries X-Request-Id — reuses an inbound one if the caller
 * (e.g. a proxy) already set it, otherwise mints a fresh one.
 */
export function attach_request_id(req, res) {
  const request_id = req.headers['x-request-id'] || new_request_id();
  res.setHeader('X-Request-Id', request_id);
  return request_id;
}
