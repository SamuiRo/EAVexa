import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import http from 'http';
import path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import FileJobStore from '../../src/core/job_store.js';
import WebhookNotifier from '../../src/core/webhook_notifier.js';
import { new_job_id } from '../../src/core/ids.js';

async function make_job_store() {
  const dir = await mkdtemp(path.join(tmpdir(), 'eavexa-webhook-'));
  return { store: new FileJobStore({ dir }), dir };
}

function start_receiver(handler) {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ headers: req.headers, body });
        handler(req, res, body);
      });
    });
    server.listen(0, () => resolve({ server, requests, port: server.address().port }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function create_job(store, callback_url, extra = {}) {
  const id = new_job_id();
  await store.create({
    id, status: 'done', template: null, metadata: {},
    result: { render_id: 'r_x', bytes: 1 }, error: null,
    callback: { url: callback_url, headers: {}, state: 'pending', delivered: false, attempts: [] },
    ...extra,
  });
  return id;
}

test('delivers successfully and signs the body when a secret is configured', async () => {
  const { store, dir } = await make_job_store();
  const { server, requests, port } = await start_receiver((req, res) => {
    res.writeHead(200); res.end('ok');
  });

  try {
    const notifier = new WebhookNotifier({ job_store: store, secret: 'topsecret' });
    const job_id = await create_job(store, `http://127.0.0.1:${port}/hook`);

    await notifier.notify(job_id, 'render.completed');

    const job = await store.get(job_id);
    assert.equal(job.callback.state, 'delivered');
    assert.equal(job.callback.delivered, true);
    assert.equal(job.callback.attempts.length, 1);
    assert.equal(job.callback.attempts[0].status_code, 200);

    assert.equal(requests.length, 1);
    const { headers, body } = requests[0];
    assert.equal(headers['x-eavexa-event'], 'render.completed');
    assert.equal(headers['x-eavexa-job-id'], job_id);
    assert.ok(headers['x-eavexa-signature']);

    const expected = createHmac('sha256', 'topsecret').update(`${headers['x-eavexa-timestamp']}.${body}`).digest('hex');
    assert.equal(headers['x-eavexa-signature'], `sha256=${expected}`);

    const payload = JSON.parse(body);
    assert.equal(payload.event, 'render.completed');
    assert.equal(payload.result.bytes, 1);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not sign the body when no secret is configured', async () => {
  const { store, dir } = await make_job_store();
  const { server, requests, port } = await start_receiver((req, res) => { res.writeHead(200); res.end(); });

  try {
    const notifier = new WebhookNotifier({ job_store: store, secret: null });
    const job_id = await create_job(store, `http://127.0.0.1:${port}/hook`);

    await notifier.notify(job_id, 'render.completed');

    assert.equal(requests[0].headers['x-eavexa-signature'], undefined);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a permanent 4xx failure is not retried', async () => {
  const { store, dir } = await make_job_store();
  const { server, requests, port } = await start_receiver((req, res) => { res.writeHead(400); res.end('bad'); });

  try {
    const notifier = new WebhookNotifier({ job_store: store, max_attempts: 5 });
    const job_id = await create_job(store, `http://127.0.0.1:${port}/hook`);

    await notifier.notify(job_id, 'render.completed');

    const job = await store.get(job_id);
    assert.equal(job.callback.state, 'failed_permanent');
    assert.equal(job.callback.attempts.length, 1);
    assert.equal(requests.length, 1, 'a non-retryable 4xx must not be retried');
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a retryable 500 is retried and can eventually succeed', async () => {
  const { store, dir } = await make_job_store();
  let call_count = 0;

  const { server, requests, port } = await start_receiver((req, res) => {
    call_count += 1;
    if (call_count === 1) { res.writeHead(500); res.end('fail'); }
    else { res.writeHead(200); res.end('ok'); }
  });

  try {
    const notifier = new WebhookNotifier({ job_store: store, max_attempts: 5 });
    const job_id = await create_job(store, `http://127.0.0.1:${port}/hook`);

    await notifier.notify(job_id, 'render.completed'); // first attempt: 500, schedules a retry ~1s out

    let job = await store.get(job_id);
    assert.equal(job.callback.state, 'pending');
    assert.equal(job.callback.attempts.length, 1);
    assert.ok(job.callback.attempts[0].next_retry_at);

    await new Promise(resolve => setTimeout(resolve, 1300)); // let the 1s backoff fire

    job = await store.get(job_id);
    assert.equal(job.callback.state, 'delivered');
    assert.equal(requests.length, 2);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('blocks a file: URL without making a network call', async () => {
  const { store, dir } = await make_job_store();

  try {
    const notifier = new WebhookNotifier({ job_store: store });
    const job_id = await create_job(store, 'file:///etc/passwd');

    await notifier.notify(job_id, 'render.completed');

    const job = await store.get(job_id);
    assert.equal(job.callback.state, 'failed_permanent');
    assert.match(job.callback.attempts[0].error, /not allowed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resume_pending() re-arms delivery for jobs left in "pending" state', async () => {
  const { store, dir } = await make_job_store();
  const { server, requests, port } = await start_receiver((req, res) => { res.writeHead(200); res.end(); });

  try {
    const notifier = new WebhookNotifier({ job_store: store });
    // Simulate a job whose retry was scheduled by a process that has since exited:
    // state is "pending" but no timer actually exists in this fresh instance.
    const job_id = await create_job(store, `http://127.0.0.1:${port}/hook`, {});
    await store.update(job_id, { callback: { url: `http://127.0.0.1:${port}/hook`, headers: {}, state: 'pending', delivered: false, attempts: [{ at: new Date().toISOString(), status_code: 500, error: null, duration_ms: 5, next_retry_at: new Date().toISOString() }] } });

    await notifier.resume_pending();
    await new Promise(resolve => setTimeout(resolve, 100));

    const job = await store.get(job_id);
    assert.equal(job.callback.state, 'delivered');
    assert.equal(requests.length, 1);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('notify() is a no-op for a job with no callback', async () => {
  const { store, dir } = await make_job_store();

  try {
    const notifier = new WebhookNotifier({ job_store: store });
    const id = new_job_id();
    await store.create({ id, status: 'done', callback: null });

    await notifier.notify(id, 'render.completed'); // must not throw
    assert.equal((await store.get(id)).callback, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
