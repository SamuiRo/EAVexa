import ImageRenderer from '../modules/renderer/image_renderer.js';
import VideoRenderer from '../modules/renderer/video_renderer.js';
import { BROWSER_MAX_RENDERS } from '../config/app_config.js';
import { log } from '../shared/logger.js';

/**
 * Pools one Chromium connection per renderer kind (image/video), lazily
 * launched on first use, with a scheduled restart every BROWSER_MAX_RENDERS
 * renders to guard against memory leaks. Restart waits for in-flight renders
 * of that kind to finish first.
 *
 * Deviation from docs/specification.md §5.6: this pools whole
 * ImageRenderer/VideoRenderer instances rather than raw Playwright pages —
 * a pragmatic choice to reuse the already-tested renderer classes instead of
 * rewriting their internals to a page-checkout model in this step.
 */
export default class BrowserPool {
  constructor({ image_renderer, video_renderer, max_renders = BROWSER_MAX_RENDERS } = {}) {
    this.image_renderer = image_renderer ?? new ImageRenderer();
    this.video_renderer = video_renderer ?? new VideoRenderer();
    this.max_renders    = max_renders;

    this.connected           = { image: false, video: false };
    this.connecting          = { image: null, video: null };
    this.in_flight           = { image: 0, video: 0 };
    this.renders_since_start = { image: 0, video: 0 };
    this.restarts = 0;
  }

  async with_image(fn) {
    return this._with('image', this.image_renderer, fn);
  }

  async with_video(fn) {
    return this._with('video', this.video_renderer, fn);
  }

  stats() {
    return {
      connected:           { ...this.connected },
      in_flight:           { ...this.in_flight },
      renders_since_start: { ...this.renders_since_start },
      restarts: this.restarts,
    };
  }

  async close() {
    await this.image_renderer.close();
    await this.video_renderer.close();
    this.connected = { image: false, video: false };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  async _with(kind, renderer, fn) {
    await this._ensure_connected(kind, renderer);
    this.in_flight[kind] += 1;

    try {
      return await fn(renderer);
    } finally {
      this.in_flight[kind] -= 1;
      this.renders_since_start[kind] += 1;

      if (this.renders_since_start[kind] >= this.max_renders && this.in_flight[kind] === 0) {
        await this._restart(kind, renderer);
      }
    }
  }

  async _ensure_connected(kind, renderer) {
    if (this.connected[kind]) return;

    // Concurrent with_image()/with_video() calls must share one in-flight
    // connect() — otherwise each of the queue's concurrent lane slots races
    // to launch its own Chromium and stomps on the others' `renderer.browser`.
    if (!this.connecting[kind]) {
      this.connecting[kind] = this._connect(kind, renderer).finally(() => {
        this.connecting[kind] = null;
      });
    }

    await this.connecting[kind];
  }

  async _connect(kind, renderer) {
    await renderer.connect();
    this.connected[kind] = true;

    // If Chromium crashes outside of our own close(), mark the pool dead so
    // the next with_* call relaunches instead of using a stale reference.
    renderer.browser?.on?.('disconnected', () => {
      this.connected[kind] = false;
    });
  }

  async _restart(kind, renderer) {
    log({ level: 'info', msg: `Restarting ${kind} browser after ${this.renders_since_start[kind]} renders`, kind });

    await renderer.close();
    this.connected[kind] = false;
    this.renders_since_start[kind] = 0;
    this.restarts += 1;
  }
}
