import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import EAVexaServer from '../../src/server/server.js';
import RenderService from '../../src/core/render_service.js';
import TemplateRegistry from '../../src/core/template_registry.js';
import BrowserPool from '../../src/core/browser_pool.js';
import RenderQueue from '../../src/core/render_queue.js';
import StorageAdapter from '../../src/core/storage_adapter.js';
import FileJobStore from '../../src/core/job_store.js';
import WebhookNotifier from '../../src/core/webhook_notifier.js';
import { read_png_size } from '../support/png_size.js';

let output_dir, job_dir, builtin_dir, server, base_url;

function start_receiver() {
  return new Promise(resolve => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200);
        res.end('ok');
      });
    });
    srv.listen(0, () => resolve({ server: srv, requests, url: `http://127.0.0.1:${srv.address().port}/hook` }));
  });
}

before(async () => {
  output_dir  = await mkdtemp(path.join(tmpdir(), 'eavexa-http-out-'));
  job_dir     = await mkdtemp(path.join(tmpdir(), 'eavexa-http-jobs-'));
  builtin_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-http-tpl-'));

  await mkdir(path.join(builtin_dir, 'greet'), { recursive: true });
  await writeFile(
    path.join(builtin_dir, 'greet', 'template.json'),
    JSON.stringify({ name: 'greet', entry: 'template.html', default_format: 'post_square', vars: [{ name: 'TITLE', required: true, example: 'Hi' }] }),
    'utf-8',
  );
  await writeFile(
    path.join(builtin_dir, 'greet', 'template.html'),
    '<html><body style="margin:0;background:#123"><h1>{{TITLE}}</h1></body></html>',
    'utf-8',
  );
  await writeFile(path.join(builtin_dir, 'greet', 'preview.png'), Buffer.from('fake-png-bytes'));

  const registry = new TemplateRegistry({ builtin_dir, user_dir: null });
  const job_store = new FileJobStore({ dir: job_dir });
  const notifier = new WebhookNotifier({ job_store });

  const service = new RenderService({
    registry,
    pool: new BrowserPool(),
    queue: new RenderQueue(),
    storage: new StorageAdapter({ output_dir }),
    job_store,
    notifier,
  });

  server = new EAVexaServer({ service, port: 0, host: '127.0.0.1' });
  await server.listen();
  base_url = `http://127.0.0.1:${server.address.port}`;
});

after(async () => {
  await server.close();
  await rm(output_dir, { recursive: true, force: true });
  await rm(job_dir, { recursive: true, force: true });
  await rm(builtin_dir, { recursive: true, force: true });
});

async function get_json(pathname) {
  const res = await fetch(`${base_url}${pathname}`);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('GET /healthz and /readyz report ok', async () => {
  assert.deepEqual((await get_json('/healthz')).body, { ok: true });
  const ready = await get_json('/readyz');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ok, true);
});

test('GET /v1/version reports eavexa/node/playwright versions', async () => {
  const { body } = await get_json('/v1/version');
  assert.equal(body.ok, true);
  assert.ok(body.eavexa);
  assert.ok(body.node.startsWith('v'));
});

test('GET /v1/formats lists the story preset', async () => {
  const { body } = await get_json('/v1/formats');
  assert.ok(body.formats.some(f => f.key === 'story'));
});

test('every response carries X-Request-Id', async () => {
  const res = await fetch(`${base_url}/healthz`);
  assert.ok(res.headers.get('x-request-id'));
});

test('unknown route -> 404 with the standard error envelope', async () => {
  const { status, body } = await get_json('/v1/nope');
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.ok(body.error.request_id);
});

test('GET /v1/templates lists the registry, GET /v1/templates/:name shows the manifest', async () => {
  const list = await get_json('/v1/templates');
  assert.ok(list.body.templates.some(t => t.name === 'greet'));

  const show = await get_json('/v1/templates/greet');
  assert.equal(show.body.template.vars[0].name, 'TITLE');
});

test('GET /v1/templates/:name/preview serves the static preview.png', async () => {
  const res = await fetch(`${base_url}/v1/templates/greet/preview`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString(), 'fake-png-bytes');
});

test('GET /v1/templates/:name/preview 404s when there is no preview.png', async () => {
  const dir = path.join(builtin_dir, 'no_preview');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'template.html'), '<html></html>', 'utf-8');

  const res = await get_json('/v1/templates/no_preview/preview');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'TEMPLATE_NOT_FOUND');
});

test('POST /v1/templates/:name/render (sync, JSON, output.type=path)', async () => {
  const res = await fetch(`${base_url}/v1/templates/greet/render?type=path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ TITLE: 'Sugar route' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.result.width, 2160); // post_square default_format @2x
  assert.ok(body.result.path);
  assert.equal(body.result.data, null);
});

test('POST /v1/render sync binary response streams real PNG bytes with the documented headers', async () => {
  const res = await fetch(`${base_url}/v1/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { name: 'greet' }, format: { width: 50, height: 40, device_scale_factor: 1 }, vars: { TITLE: 'Bin' } }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok(res.headers.get('x-render-id'));
  assert.equal(res.headers.get('x-render-width'), '50');
  assert.ok(res.headers.get('x-result-path'));

  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(read_png_size(buf), { width: 50, height: 40 });
});

test('sync render also persists a fetchable job record, and result.url resolves', async () => {
  const render_res = await fetch(`${base_url}/v1/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { name: 'greet' }, format: { width: 30, height: 20, device_scale_factor: 1 }, vars: { TITLE: 'X' }, output: { type: 'url' } }),
  });
  const { result } = (await render_res.json());

  assert.match(result.url, new RegExp(`^${base_url}/v1/jobs/${result.render_id}/result$`));

  const job_res = await get_json(`/v1/jobs/${result.render_id}`);
  assert.equal(job_res.body.job.status, 'done');

  const file_res = await fetch(result.url);
  assert.equal(file_res.status, 200);
  const buf = Buffer.from(await file_res.arrayBuffer());
  assert.deepEqual(read_png_size(buf), { width: 30, height: 20 });
});

test('output.type=base64 returns the file contents inline', async () => {
  const res = await fetch(`${base_url}/v1/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { name: 'greet' }, format: { width: 10, height: 10, device_scale_factor: 1 }, vars: { TITLE: 'B64' }, output: { type: 'base64' } }),
  });
  const { result } = await res.json();

  assert.ok(result.data);
  const decoded = Buffer.from(result.data, 'base64');
  assert.deepEqual(read_png_size(decoded), { width: 10, height: 10 });
});

test('output.type=s3 is rejected as not-yet-implemented', async () => {
  const res = await fetch(`${base_url}/v1/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { name: 'greet' }, format: 'post_square', vars: { TITLE: 'x' }, output: { type: 's3' } }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'INVALID_REQUEST');
});

test('GET /v1/jobs/:id/result supports Range and ETag/If-None-Match', async () => {
  const render_res = await fetch(`${base_url}/v1/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { name: 'greet' }, format: { width: 40, height: 30, device_scale_factor: 1 }, vars: { TITLE: 'Range' }, output: { type: 'path' } }),
  });
  const { result } = await render_res.json();
  const result_url = `${base_url}/v1/jobs/${result.render_id}/result`;

  const full = await fetch(result_url);
  const etag = full.headers.get('etag');
  assert.ok(etag);

  const ranged = await fetch(result_url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${result.bytes}`);
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);

  const not_modified = await fetch(result_url, { headers: { 'If-None-Match': etag } });
  assert.equal(not_modified.status, 304);
});

test('GET /v1/jobs paginates and filters by status', async () => {
  const { body } = await get_json('/v1/jobs?status=done&limit=3');
  assert.ok(body.jobs.length <= 3);
  assert.ok(body.jobs.every(job => job.status === 'done'));
});

test('async render (mode=async) returns 202, and completes with a delivered webhook', async () => {
  const receiver = await start_receiver();

  try {
    const res = await fetch(`${base_url}/v1/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { name: 'greet' }, format: 'post_square', vars: { TITLE: 'Async' },
        mode: 'async', callback_url: receiver.url,
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 202);
    assert.equal(body.status, 'queued');
    assert.match(body.poll_url, /^\/v1\/jobs\//);

    await new Promise(resolve => setTimeout(resolve, 1500));

    const job_res = await get_json(body.poll_url);
    assert.equal(job_res.body.job.status, 'done');
    assert.equal(job_res.body.job.callback.state, 'delivered');
    assert.equal(receiver.requests.at(-1).event, 'render.completed');
  } finally {
    await new Promise(resolve => receiver.server.close(resolve));
  }
});

test('Idempotency-Key replays the original sync result instead of re-rendering', async () => {
  const key = `idem-${Date.now()}`;
  const make = () => fetch(`${base_url}/v1/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ source: { name: 'greet' }, format: { width: 15, height: 15, device_scale_factor: 1 }, vars: { TITLE: 'Idem' }, output: { type: 'path' } }),
  });

  const first = await (await make()).json();
  const second = await (await make()).json();

  assert.equal(first.result.render_id, second.result.render_id, 'a repeated Idempotency-Key must not trigger a second render');
});

test('DELETE /v1/jobs/:id removes a finished job record and its result file', async () => {
  const render_res = await fetch(`${base_url}/v1/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { name: 'greet' }, format: { width: 12, height: 12, device_scale_factor: 1 }, vars: { TITLE: 'Del' }, output: { type: 'path' } }),
  });
  const { result } = await render_res.json();

  const del_res = await fetch(`${base_url}/v1/jobs/${result.render_id}`, { method: 'DELETE' });
  const del_body = await del_res.json();
  assert.equal(del_body.deleted, true);

  const after_del = await get_json(`/v1/jobs/${result.render_id}`);
  assert.equal(after_del.status, 404);
  assert.equal(after_del.body.error.code, 'JOB_NOT_FOUND');

  await assert.rejects(readFile(result.local_path));
});

test('POST /v1/jobs/:id/retry-callback makes a fresh attempt even after failed_permanent', async () => {
  // A 4xx response is recorded failed_permanent, which the normal notify()
  // path never retries — retry-callback must bypass that guard explicitly.
  const permanent_fail_receiver = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(400); res.end('bad'); });
  });
  await new Promise(resolve => permanent_fail_receiver.listen(0, resolve));
  const bad_url = `http://127.0.0.1:${permanent_fail_receiver.address().port}/hook`;

  try {
    const res = await fetch(`${base_url}/v1/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { name: 'greet' }, format: 'post_square', vars: { TITLE: 'Retry' },
        mode: 'async', callback_url: bad_url,
      }),
    });
    const { job_id } = await res.json();
    await new Promise(resolve => setTimeout(resolve, 1500));

    const before = await get_json(`/v1/jobs/${job_id}`);
    assert.equal(before.body.job.callback.state, 'failed_permanent');
    const attempts_before = before.body.job.callback.attempts.length;

    await fetch(`${base_url}/v1/jobs/${job_id}/retry-callback`, { method: 'POST' });
    await new Promise(resolve => setTimeout(resolve, 500));

    const after = await get_json(`/v1/jobs/${job_id}`);
    assert.ok(after.body.job.callback.attempts.length > attempts_before, 'retry-callback must bypass the failed_permanent guard and attempt delivery again');
  } finally {
    await new Promise(resolve => permanent_fail_receiver.close(resolve));
  }
});
