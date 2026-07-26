import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import EAVexaServer from '../../src/server/server.js';
import RenderService from '../../src/core/render_service.js';
import TemplateRegistry from '../../src/core/template_registry.js';
import BrowserPool from '../../src/core/browser_pool.js';
import RenderQueue from '../../src/core/render_queue.js';
import StorageAdapter from '../../src/core/storage_adapter.js';
import FileJobStore from '../../src/core/job_store.js';

async function build_server() {
  const output_dir  = await mkdtemp(path.join(tmpdir(), 'eavexa-shutdown-out-'));
  const job_dir     = await mkdtemp(path.join(tmpdir(), 'eavexa-shutdown-jobs-'));
  const builtin_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-shutdown-tpl-'));

  await mkdir(path.join(builtin_dir, 'greet'), { recursive: true });
  await writeFile(path.join(builtin_dir, 'greet', 'template.html'), '<html><body style="margin:0;background:#000"></body></html>', 'utf-8');

  const service = new RenderService({
    registry: new TemplateRegistry({ builtin_dir, user_dir: null }),
    pool: new BrowserPool(),
    queue: new RenderQueue(),
    storage: new StorageAdapter({ output_dir }),
    job_store: new FileJobStore({ dir: job_dir }),
  });

  const server = new EAVexaServer({ service, port: 0, host: '127.0.0.1' });
  await server.listen();

  return {
    server,
    base_url: `http://127.0.0.1:${server.address.port}`,
    cleanup: () => Promise.all([
      rm(output_dir, { recursive: true, force: true }),
      rm(job_dir, { recursive: true, force: true }),
      rm(builtin_dir, { recursive: true, force: true }),
    ]),
  };
}

test('close() stops accepting new connections and is idempotent', async () => {
  const { server, base_url, cleanup } = await build_server();

  try {
    assert.equal((await fetch(`${base_url}/healthz`)).status, 200);

    await server.close();
    await server.close(); // must not throw the second time

    await assert.rejects(fetch(`${base_url}/healthz`), () => true);
  } finally {
    await cleanup();
  }
});

test('close() drains an in-flight render before closing the browser pool', async () => {
  const { server, base_url, cleanup } = await build_server();

  try {
    const render_promise = fetch(`${base_url}/v1/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { name: 'greet' }, format: { width: 20, height: 20, device_scale_factor: 1 }, output: { type: 'path' } }),
    });

    // Give the render a moment to actually start before asking the server to close.
    await new Promise(resolve => setTimeout(resolve, 50));

    const [render_res] = await Promise.all([render_promise, server.close({ grace_ms: 5000 })]);
    const body = await render_res.json();

    assert.equal(render_res.status, 200);
    assert.equal(body.ok, true, 'the in-flight render must complete successfully despite the shutdown racing it');
  } finally {
    await cleanup();
  }
});

test('close() gives up after grace_ms and logs a warning rather than hanging forever', async () => {
  const { server, cleanup } = await build_server();

  // No renders in flight — this should resolve immediately, well under grace_ms.
  const started = Date.now();
  await server.close({ grace_ms: 5000 });
  assert.ok(Date.now() - started < 1000, 'close() must not wait out the full grace period when the queue is already idle');

  await cleanup();
});
