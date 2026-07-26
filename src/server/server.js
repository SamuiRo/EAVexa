import http from 'http';
import Router from './router.js';
import IdempotencyStore from './idempotency_store.js';
import { attach_request_id } from './middleware/request_id.js';
import { check_auth } from './middleware/auth.js';
import { send_json, send_error } from './middleware/errors.js';
import register_render_routes from './routes/render.js';
import register_jobs_routes from './routes/jobs.js';
import register_templates_routes from './routes/templates.js';
import register_meta_routes from './routes/meta.js';
import { RenderError } from '../core/errors.js';
import { log } from '../shared/logger.js';
import { EAVEXA_PORT, EAVEXA_HOST, SHUTDOWN_GRACE_MS } from '../config/app_config.js';

/**
 * node:http wrapper exposing the same core (`RenderService`) as the CLI over
 * `/v1/*`. See docs/specification.md §7-8 and docs/api.md.
 */
export default class EAVexaServer {
  constructor({ service, port = EAVEXA_PORT, host = EAVEXA_HOST } = {}) {
    this.service = service;
    this.port = port;
    this.host = host;
    this.idempotency = new IdempotencyStore();
    this.router = new Router();
    this._closing = false;

    const ctx = { service: this.service, idempotency: this.idempotency };
    register_render_routes(this.router, ctx);
    register_jobs_routes(this.router, ctx);
    register_templates_routes(this.router, ctx);
    register_meta_routes(this.router, ctx);

    this.http_server = http.createServer((req, res) => this._handle(req, res));
  }

  async listen() {
    await this.service.start();

    await new Promise((resolve, reject) => {
      this.http_server.once('error', reject);
      this.http_server.listen(this.port, this.host, () => {
        this.http_server.removeListener('error', reject);
        resolve();
      });
    });

    return this;
  }

  get address() {
    const addr = this.http_server.address();
    return typeof addr === 'object' && addr ? addr : null;
  }

  /**
   * Graceful shutdown: stop accepting new connections, wait up to
   * SHUTDOWN_GRACE_MS for the render queue to drain, then close the browser
   * pool. Safe to call more than once.
   */
  async close({ grace_ms = SHUTDOWN_GRACE_MS } = {}) {
    if (this._closing) return;
    this._closing = true;

    await new Promise(resolve => this.http_server.close(resolve));
    await this._drain_queue(grace_ms);
    await this.service.close();
  }

  async _drain_queue(grace_ms) {
    const deadline = Date.now() + grace_ms;

    for (;;) {
      const stats = this.service.queue.stats();
      const active = sum(stats.running) + sum(stats.queued);
      if (active === 0) return;
      if (Date.now() >= deadline) {
        log({ level: 'warn', msg: `Shutdown grace period (${grace_ms}ms) elapsed with ${active} render(s) still active` });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  async _handle(req, res) {
    const request_id = attach_request_id(req, res);
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (this._closing && url.pathname !== '/healthz') {
        throw new RenderError('QUEUE_FULL', 'Server is shutting down');
      }

      check_auth(req, url.pathname);

      const matched = this.router.match(req.method, url.pathname);

      if (!matched) {
        send_json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}`, details: {}, request_id } });
        return;
      }

      if (matched.method_not_allowed) {
        send_json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed for ${url.pathname}`, details: {}, request_id } });
        return;
      }

      await matched.handler(req, res, matched.params, url);
    } catch (error) {
      log_request_error(error, request_id, req, url);
      send_error(res, error, request_id);
    }
  }
}

function sum(counts) {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

function log_request_error(error, request_id, req, url) {
  const render_error = error instanceof RenderError ? error : new RenderError('INTERNAL', error.message);
  const level = (render_error.http_status ?? 500) >= 500 ? 'error' : 'debug';

  log({ level, msg: `${req.method} ${url.pathname} -> ${render_error.code}: ${render_error.message}`, request_id });
}
