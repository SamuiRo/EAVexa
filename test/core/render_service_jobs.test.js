import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import RenderService from '../../src/core/render_service.js';
import BrowserPool from '../../src/core/browser_pool.js';
import RenderQueue from '../../src/core/render_queue.js';
import StorageAdapter from '../../src/core/storage_adapter.js';
import FileJobStore from '../../src/core/job_store.js';
import WebhookNotifier from '../../src/core/webhook_notifier.js';
import { new_job_id } from '../../src/core/ids.js';

function start_receiver() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200);
        res.end('ok');
      });
    });
    server.listen(0, () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

let output_dir;
let job_dir;
let template_dir;
let receiver;

before(async () => {
  output_dir   = await mkdtemp(path.join(tmpdir(), 'eavexa-jobs-out-'));
  job_dir      = await mkdtemp(path.join(tmpdir(), 'eavexa-jobs-store-'));
  template_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-jobs-tpl-'));
  receiver     = await start_receiver();

  await writeFile(path.join(template_dir, 'template.html'), '<html><body style="margin:0;background:#000"></body></html>', 'utf-8');
});

after(async () => {
  await close(receiver.server);
  await rm(output_dir, { recursive: true, force: true });
  await rm(job_dir, { recursive: true, force: true });
  await rm(template_dir, { recursive: true, force: true });
});

function create_service() {
  const job_store = new FileJobStore({ dir: job_dir });
  const notifier  = new WebhookNotifier({ job_store });

  return new RenderService({
    registry: null,
    pool: new BrowserPool(),
    queue: new RenderQueue(),
    storage: new StorageAdapter({ output_dir }),
    job_store,
    notifier,
  });
}

test('submit() runs the job in the background and delivers a webhook on completion', async () => {
  const service = create_service();

  try {
    const { job, done } = await service.submit({
      source: { path: path.join(template_dir, 'template.html') },
      format: { width: 20, height: 10, device_scale_factor: 1 },
      output: { filename: 'submit.png', dir: 'submit_job' },
      callback_url: receiver.url,
    });

    assert.equal(job.status, 'queued');
    await done;

    const final = await service.job_store.get(job.id);
    assert.equal(final.status, 'done');
    assert.equal(final.result.width, 20);
    assert.equal(final.callback.state, 'delivered');

    assert.equal(receiver.requests.at(-1).event, 'render.completed');
    assert.equal(receiver.requests.at(-1).job_id, job.id);
  } finally {
    await service.close();
  }
});

test('cancel() stops an in-flight render and records status "cancelled"', async () => {
  const service = create_service();

  try {
    const { job, done } = await service.submit({
      source: { path: path.join(template_dir, 'template.html') },
      format: { width: 20, height: 10, device_scale_factor: 1 },
      video: { duration: 3, fps: 30 }, // 90 frames — plenty of time to cancel mid-render
      output: { filename: 'cancel.mp4', dir: 'cancel_job' },
      callback_url: receiver.url,
    });

    await new Promise(resolve => setTimeout(resolve, 150)); // let it start rendering frames
    const cancelled = await service.cancel(job.id);
    assert.equal(cancelled.status, 'cancelled');

    await done;

    const final = await service.job_store.get(job.id);
    assert.equal(final.status, 'cancelled');
    assert.equal(final.error.code, 'CANCELLED');
  } finally {
    await service.close();
  }
});

test('cancel() on an already-finished job is a no-op that returns it unchanged', async () => {
  const service = create_service();

  try {
    const { job, done } = await service.submit({
      source: { path: path.join(template_dir, 'template.html') },
      format: { width: 10, height: 10, device_scale_factor: 1 },
      output: { filename: 'done.png', dir: 'done_job' },
    });

    await done;
    const result = await service.cancel(job.id);
    assert.equal(result.status, 'done');
  } finally {
    await service.close();
  }
});

// ─── The Крок 3 acceptance scenario ─────────────────────────────────────────
// "kill the process during a render -> after restart, a render.failed arrives"
test('start() recovers a job orphaned by a crashed process and fires render.failed(INTERRUPTED)', async () => {
  const job_store = new FileJobStore({ dir: job_dir });
  const notifier  = new WebhookNotifier({ job_store });

  // Simulate a process that died mid-render: a job record stuck in "running"
  // with no live queue/pool behind it, exactly what a hard kill would leave.
  const orphaned_id = new_job_id();
  await job_store.create({
    id: orphaned_id,
    status: 'running',
    mode: 'async',
    progress: { phase: 'capture', current: 10, total: 90, ratio: 0.4 },
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    template: null,
    type: 'video',
    metadata: { row_id: 42 },
    result: null,
    error: null,
    callback: { url: receiver.url, headers: {}, state: 'pending', delivered: false, attempts: [] },
  });

  const restarted_service = new RenderService({
    registry: null,
    pool: new BrowserPool(),
    queue: new RenderQueue(),
    storage: new StorageAdapter({ output_dir }),
    job_store,
    notifier,
  });

  try {
    receiver.requests.length = 0;
    await restarted_service.start();

    const recovered = await job_store.get(orphaned_id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error.code, 'INTERRUPTED');

    await new Promise(resolve => setTimeout(resolve, 100)); // let the fire-and-forget notify() land
    const delivered = receiver.requests.find(req => req.job_id === orphaned_id);
    assert.ok(delivered, 'render.failed must have been POSTed for the orphaned job');
    assert.equal(delivered.event, 'render.failed');
    assert.equal(delivered.error.code, 'INTERRUPTED');
    assert.equal(delivered.metadata.row_id, 42);
  } finally {
    await restarted_service.close();
  }
});

test('start() cleans up orphaned .eavexa_* frame directories in TMP_DIR', async () => {
  const { existsSync } = await import('fs');
  const { tmpdir: os_tmpdir } = await import('os');
  const leftover = path.join(os_tmpdir(), `.eavexa_orphan_frames_${Date.now()}`);
  await mkdir(leftover, { recursive: true });
  await writeFile(path.join(leftover, 'frame_000000.png'), 'x');

  const service = create_service();

  try {
    await service.start();
    assert.equal(existsSync(leftover), false, 'start() must remove leftover .eavexa_* frame directories');
  } finally {
    await service.close();
    await rm(leftover, { recursive: true, force: true });
  }
});
