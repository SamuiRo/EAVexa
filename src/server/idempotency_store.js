import { IDEMPOTENCY_TTL_MS } from '../config/app_config.js';

/**
 * In-memory Idempotency-Key store. Ephemeral by design (matches the
 * documented 10-minute window) — doesn't need to survive a restart.
 * See docs/specification.md §7.2.
 */
export default class IdempotencyStore {
  constructor({ ttl_ms = IDEMPOTENCY_TTL_MS } = {}) {
    this.ttl_ms = ttl_ms;
    this._map = new Map(); // key -> { expires_at, envelope }
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expires_at) {
      this._map.delete(key);
      return null;
    }

    return entry.envelope;
  }

  set(key, envelope) {
    this._map.set(key, { expires_at: Date.now() + this.ttl_ms, envelope });
  }
}
