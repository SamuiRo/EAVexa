import { EAVEXA_PUBLIC_URL } from '../config/app_config.js';

/**
 * Resolve the base URL this server's own links (result.url, poll_url) should
 * use. See docs/decisions.md §Р2.2 — EAVEXA_PUBLIC_URL always wins; otherwise
 * fall back to the inbound request's own Host/X-Forwarded-* (correct for the
 * common case: no reverse proxy, `eavexa serve` bound to the same host the
 * client is talking to).
 */
export function resolve_public_base_url(req) {
  if (EAVEXA_PUBLIC_URL) return EAVEXA_PUBLIC_URL.replace(/\/+$/, '');

  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  return host ? `${proto}://${host}` : null;
}
