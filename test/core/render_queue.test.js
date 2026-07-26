import { test } from 'node:test';
import assert from 'node:assert/strict';
import RenderQueue from '../../src/core/render_queue.js';
import { RenderError } from '../../src/core/errors.js';
import { sleep } from '../../src/shared/utils.js';

test('respects per-lane concurrency limits independently', async () => {
  const queue = new RenderQueue({ lanes: { image: 2, video: 1 }, queue_max: 100 });

  let image_running = 0;
  let image_peak = 0;

  const image_task = async () => {
    image_running += 1;
    image_peak = Math.max(image_peak, image_running);
    await sleep(30);
    image_running -= 1;
    return 'ok';
  };

  const results = await Promise.all([
    queue.enqueue(image_task, { lane: 'image' }),
    queue.enqueue(image_task, { lane: 'image' }),
    queue.enqueue(image_task, { lane: 'image' }),
    queue.enqueue(image_task, { lane: 'image' }),
  ]);

  assert.equal(image_peak, 2, 'no more than 2 image tasks should run at once');
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok']);
});

test('a slow video task does not block queued image tasks', async () => {
  const queue = new RenderQueue({ lanes: { image: 1, video: 1 }, queue_max: 100 });
  const order = [];

  const video_task = async () => { await sleep(60); order.push('video'); };
  const image_task = async () => { order.push('image'); };

  await Promise.all([
    queue.enqueue(video_task, { lane: 'video' }),
    queue.enqueue(image_task, { lane: 'image' }),
  ]);

  assert.deepEqual(order, ['image', 'video'], 'the fast image lane must not wait on the slow video lane');
});

test('rejects with QUEUE_FULL once queue_max is reached', async () => {
  const queue = new RenderQueue({ lanes: { image: 1 }, queue_max: 1 });

  const blocker = queue.enqueue(() => sleep(50), { lane: 'image' });

  await assert.rejects(
    queue.enqueue(() => sleep(10), { lane: 'image' }),
    error => { assert.equal(error.code, 'QUEUE_FULL'); return true; },
  );

  await blocker;
});

test('rejects with RENDER_TIMEOUT when a task exceeds timeout_ms', async () => {
  const queue = new RenderQueue({ lanes: { image: 1 }, queue_max: 10 });

  await assert.rejects(
    queue.enqueue(() => sleep(100), { lane: 'image', timeout_ms: 10 }),
    error => { assert.ok(error instanceof RenderError); assert.equal(error.code, 'RENDER_TIMEOUT'); return true; },
  );
});

test('rejects with CANCELLED when the signal aborts before the task starts', async () => {
  const queue = new RenderQueue({ lanes: { image: 1 }, queue_max: 10 });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    queue.enqueue(() => 'never', { lane: 'image', signal: controller.signal }),
    error => { assert.equal(error.code, 'CANCELLED'); return true; },
  );
});

test('rejects with INVALID_REQUEST for an unknown lane', async () => {
  const queue = new RenderQueue({ lanes: { image: 1 }, queue_max: 10 });

  await assert.rejects(
    queue.enqueue(() => 'x', { lane: 'nope' }),
    error => { assert.equal(error.code, 'INVALID_REQUEST'); return true; },
  );
});
