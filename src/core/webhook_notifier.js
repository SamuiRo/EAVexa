import { createHmac } from 'crypto';
import { new_delivery_id } from './ids.js';
import { log } from '../shared/logger.js';
import {
  WEBHOOK_SECRET, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_TIMEOUT_MS,
  WEBHOOK_ALLOW_PRIVATE, WEBHOOK_ALLOWED_HOSTS,
} from '../config/app_config.js';

// 1s -> 5s -> 20s -> 60s -> 300s, per docs/specification.md §8.3.
const BACKOFF_MS = [1000, 5000, 20000, 60000, 300000];
const BLOCKED_PROTOCOLS = ['file:', 'ftp:'];
const BLOCKED_HOSTS = ['169.254.169.254']; // cloud metadata endpoint
const PRIVATE_HOST_PATTERN = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$)|^172\.(1[6-9]|2\d|3[01])\./;

/**
 * Delivers `render.completed`/`render.failed` webhooks with HMAC signing and
 * backoff retries that survive process restarts (state lives in JobStore, not
 * in memory). See docs/specification.md §8.
 */
export default class WebhookNotifier {
  constructor({
    job_store,
    secret = WEBHOOK_SECRET,
    max_attempts = WEBHOOK_MAX_ATTEMPTS,
    timeout_ms = WEBHOOK_TIMEOUT_MS,
    allow_private = WEBHOOK_ALLOW_PRIVATE,
    allowed_hosts = WEBHOOK_ALLOWED_HOSTS,
    fetch_impl = fetch,
  } = {}) {
    this.job_store = job_store;
    this.secret = secret;
    this.max_attempts = max_attempts;
    this.timeout_ms = timeout_ms;
    this.allow_private = allow_private;
    this.allowed_hosts = allowed_hosts;
    this.fetch_impl = fetch_impl;
    this._timers = new Map(); // job_id -> Timeout, for scheduled retries
    this._warned_no_secret = false;
  }

  /**
   * Trigger delivery for a job that just finished. No-op if the job has no callback.
   */
  /**
   * @param {string} job_id
   * @param {string} event
   * @param {{ force?: boolean }} [opts] `force` bypasses the delivered/failed_permanent
   *   guard — used by the manual `POST /v1/jobs/:id/retry-callback` endpoint.
   */
  async notify(job_id, event, { force = false } = {}) {
    const job = await this.job_store.get(job_id);
    if (!job?.callback) return;

    if (!this.secret && !this._warned_no_secret) {
      this._warned_no_secret = true;
      log({ level: 'warn', msg: 'WEBHOOK_SECRET is not set — outgoing webhooks will not carry X-EAVexa-Signature' });
    }

    await this._attempt(job_id, event, 1, force);
  }

  /**
   * Re-arm delivery for jobs whose retry was scheduled by a process that has
   * since exited (a CLI invocation, or a server restart). Called from
   * RenderService.start().
   */
  async resume_pending() {
    const jobs = await this.job_store.pending_callbacks();

    for (const job of jobs) {
      const event = job.status === 'failed' || job.status === 'cancelled' ? 'render.failed' : 'render.completed';
      const next_attempt = (job.callback.attempts?.length ?? 0) + 1;
      this._attempt(job.id, event, next_attempt).catch(() => {});
    }
  }

  stats() {
    return { pending_timers: this._timers.size };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  async _attempt(job_id, event, attempt_number, force = false) {
    const job = await this.job_store.get(job_id);
    if (!job?.callback) return;
    if (!force && (job.callback.state === 'delivered' || job.callback.state === 'failed_permanent')) return;

    let host_error = null;

    try {
      this._validate_url(job.callback.url);
    } catch (error) {
      host_error = error.message;
    }

    const delivery_id = new_delivery_id();
    const attempt_record = { at: new Date().toISOString(), status_code: null, error: host_error, duration_ms: 0, next_retry_at: null };

    if (host_error) {
      await this._record_attempt(job, 'failed_permanent', attempt_record);
      return;
    }

    const body = JSON.stringify(this._build_payload(job, event, delivery_id));
    const headers = this._build_headers(job, event, delivery_id, body);
    const started = Date.now();

    let status_code = null;
    let error_message = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout_ms);

      try {
        const response = await this.fetch_impl(job.callback.url, { method: 'POST', headers, body, signal: controller.signal });
        status_code = response.status;
        if (!response.ok) error_message = `HTTP ${response.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      error_message = error.name === 'AbortError' ? `timed out after ${this.timeout_ms}ms` : error.message;
    }

    attempt_record.status_code = status_code;
    attempt_record.error = error_message;
    attempt_record.duration_ms = Date.now() - started;

    const success = status_code !== null && status_code >= 200 && status_code < 300;

    if (success) {
      await this._record_attempt(job, 'delivered', attempt_record);
      return;
    }

    const retryable = this._is_retryable(status_code);

    if (!retryable || attempt_number >= this.max_attempts) {
      await this._record_attempt(job, retryable ? 'failed' : 'failed_permanent', attempt_record);
      return;
    }

    const delay_ms = BACKOFF_MS[attempt_number - 1] ?? BACKOFF_MS.at(-1);
    attempt_record.next_retry_at = new Date(Date.now() + delay_ms).toISOString();

    await this._record_attempt(job, 'pending', attempt_record);

    const timer = setTimeout(() => {
      this._timers.delete(job_id);
      this._attempt(job_id, event, attempt_number + 1).catch(() => {});
    }, delay_ms);
    timer.unref?.(); // a scheduled retry must never keep a one-shot CLI process alive

    this._timers.set(job_id, timer);
  }

  async _record_attempt(job, state, attempt_record) {
    const callback = {
      ...job.callback,
      state,
      delivered: state === 'delivered',
      attempts: [...(job.callback.attempts ?? []), attempt_record],
    };

    await this.job_store.update(job.id, { callback });
  }

  _build_payload(job, event, delivery_id) {
    return {
      event,
      job_id: job.id,
      delivery_id,
      sent_at: new Date().toISOString(),
      template: job.template ?? null,
      metadata: job.metadata ?? {},
      result: event === 'render.completed' ? job.result : null,
      error: event === 'render.failed' ? job.error : null,
    };
  }

  _build_headers(job, event, delivery_id, body) {
    const headers = {
      'Content-Type': 'application/json',
      'X-EAVexa-Event': event,
      'X-EAVexa-Job-Id': job.id,
      'X-EAVexa-Delivery': delivery_id,
      ...job.callback.headers,
    };

    if (this.secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', this.secret).update(`${timestamp}.${body}`).digest('hex');
      headers['X-EAVexa-Timestamp'] = String(timestamp);
      headers['X-EAVexa-Signature'] = `sha256=${signature}`;
    }

    return headers;
  }

  _validate_url(raw_url) {
    const url = new URL(raw_url);

    if (BLOCKED_PROTOCOLS.includes(url.protocol)) {
      throw new Error(`Webhook protocol "${url.protocol}" is not allowed`);
    }

    if (BLOCKED_HOSTS.includes(url.hostname)) {
      throw new Error(`Webhook host "${url.hostname}" is blocked`);
    }

    if (this.allowed_hosts && !this.allowed_hosts.includes(url.hostname)) {
      throw new Error(`Webhook host "${url.hostname}" is not in WEBHOOK_ALLOWED_HOSTS`);
    }

    if (!this.allow_private && PRIVATE_HOST_PATTERN.test(url.hostname)) {
      throw new Error(`Webhook host "${url.hostname}" looks private; set WEBHOOK_ALLOW_PRIVATE=true to allow it`);
    }
  }

  _is_retryable(status_code) {
    if (status_code === null) return true; // network error / timeout
    if (status_code === 408 || status_code === 429) return true;
    if (status_code >= 500) return true;
    return false;
  }
}
