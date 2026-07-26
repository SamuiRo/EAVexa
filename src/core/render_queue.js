import { RenderError } from './errors.js';
import { RENDER_CONCURRENCY, VIDEO_CONCURRENCY, QUEUE_MAX } from '../config/app_config.js';

const DEFAULT_LANES = {
  image: RENDER_CONCURRENCY,
  video: VIDEO_CONCURRENCY,
};

/**
 * Two independent concurrency lanes (image / video) so a long video render
 * never blocks a queue of quick image renders. See docs/specification.md §5.7.
 */
export default class RenderQueue {
  constructor({ lanes = DEFAULT_LANES, queue_max = QUEUE_MAX } = {}) {
    this.limits  = { ...lanes };
    this.queue_max = queue_max;
    this.running = Object.fromEntries(Object.keys(this.limits).map(lane => [lane, 0]));
    this.pending = Object.fromEntries(Object.keys(this.limits).map(lane => [lane, []]));
  }

  /**
   * @param {() => Promise<*>} task
   * @param {{ lane: 'image'|'video', timeout_ms?: number, signal?: AbortSignal }} opts
   * @returns {Promise<*>}
   */
  enqueue(task, { lane, timeout_ms, signal } = {}) {
    if (!(lane in this.limits)) {
      return Promise.reject(new RenderError('INVALID_REQUEST', `Unknown queue lane "${lane}"`));
    }

    if (signal?.aborted) {
      return Promise.reject(new RenderError('CANCELLED', 'Render was cancelled before it started'));
    }

    if (this._depth() >= this.queue_max) {
      return Promise.reject(new RenderError('QUEUE_FULL', `Render queue is full (max ${this.queue_max})`, {
        queue_max: this.queue_max,
      }));
    }

    return new Promise((resolve, reject) => {
      this.pending[lane].push({ task, resolve, reject, timeout_ms, signal });
      this._drain(lane);
    });
  }

  stats() {
    return {
      queued:  Object.fromEntries(Object.entries(this.pending).map(([lane, list]) => [lane, list.length])),
      running: { ...this.running },
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  _depth() {
    const queued  = Object.values(this.pending).reduce((sum, list) => sum + list.length, 0);
    const running = Object.values(this.running).reduce((sum, n) => sum + n, 0);

    return queued + running;
  }

  _drain(lane) {
    while (this.running[lane] < this.limits[lane] && this.pending[lane].length > 0) {
      const entry = this.pending[lane].shift();
      this._run(lane, entry);
    }
  }

  async _run(lane, entry) {
    this.running[lane] += 1;

    let timer;
    const timeout_promise = entry.timeout_ms
      ? new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new RenderError('RENDER_TIMEOUT', `Render exceeded timeout of ${entry.timeout_ms}ms`)),
            entry.timeout_ms,
          );
        })
      : null;

    let abort_handler;
    const abort_promise = entry.signal
      ? new Promise((_, reject) => {
          abort_handler = () => reject(new RenderError('CANCELLED', 'Render was cancelled'));
          entry.signal.addEventListener('abort', abort_handler, { once: true });
        })
      : null;

    const racers = [entry.task()];
    if (timeout_promise) racers.push(timeout_promise);
    if (abort_promise) racers.push(abort_promise);

    try {
      const result = await Promise.race(racers);
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort_handler) entry.signal.removeEventListener('abort', abort_handler);

      this.running[lane] -= 1;
      this._drain(lane);
    }
  }
}
