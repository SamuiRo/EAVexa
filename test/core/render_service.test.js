import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import RenderService from '../../src/core/render_service.js';
import TemplateRegistry from '../../src/core/template_registry.js';
import BrowserPool from '../../src/core/browser_pool.js';
import RenderQueue from '../../src/core/render_queue.js';
import StorageAdapter from '../../src/core/storage_adapter.js';
import { RenderError } from '../../src/core/errors.js';
import { read_png_size } from '../support/png_size.js';
import { make_test_image } from '../support/test_image.js';

let output_dir;
let builtin_dir;
let service;

before(async () => {
  output_dir  = await mkdtemp(path.join(tmpdir(), 'eavexa-render-service-out-'));
  builtin_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-render-service-tpl-'));

  await mkdir(path.join(builtin_dir, 'greeting'), { recursive: true });
  await writeFile(
    path.join(builtin_dir, 'greeting', 'template.json'),
    JSON.stringify({
      name: 'greeting', entry: 'template.html',
      vars: [{ name: 'TITLE', required: true }],
    }),
    'utf-8',
  );
  await writeFile(
    path.join(builtin_dir, 'greeting', 'template.html'),
    '<html><body style="margin:0;background:#fff"><h1>{{TITLE}}</h1></body></html>',
    'utf-8',
  );

  const registry = new TemplateRegistry({ builtin_dir, user_dir: null });
  const pool     = new BrowserPool();
  const queue    = new RenderQueue();
  const storage  = new StorageAdapter({ output_dir });

  service = new RenderService({ registry, pool, queue, storage });
});

after(async () => {
  await service.close();
  await rm(output_dir, { recursive: true, force: true });
  await rm(builtin_dir, { recursive: true, force: true });
});

test('renders an image via the template registry, validating required vars', async () => {
  const result = await service.render({
    source: { name: 'greeting' },
    format: { width: 50, height: 40, device_scale_factor: 2 },
    vars: { TITLE: 'Hi' },
    output: { filename: 'greeting.png', dir: 'job_a' },
  });

  assert.equal(result.type, 'image');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.width, 100);
  assert.equal(result.height, 80);
  assert.equal(result.storage, 'local');
  assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);

  const { readFile } = await import('fs/promises');
  const png = await readFile(result.local_path);
  const size = read_png_size(png);
  assert.equal(size.width, 100);
  assert.equal(size.height, 80);
});

test('rejects with MISSING_REQUIRED_VAR when a required template var is missing', async () => {
  await assert.rejects(
    service.render({
      source: { name: 'greeting' },
      format: { width: 50, height: 40, device_scale_factor: 1 },
      vars: {},
      output: { filename: 'x.png', dir: 'job_b' },
    }),
    error => {
      assert.ok(error instanceof RenderError);
      assert.equal(error.code, 'MISSING_REQUIRED_VAR');
      return true;
    },
  );
});

test('renders an image from a direct file source (the legacy jobs.json path)', async () => {
  const template_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-render-service-file-'));

  try {
    const template_path = path.join(template_dir, 'template.html');
    await writeFile(template_path, '<html><body style="margin:0;background:#000"></body></html>', 'utf-8');

    const result = await service.render({
      source: { path: template_path },
      format: { width: 20, height: 10, device_scale_factor: 1 },
      output: { filename: 'file.png', dir: 'job_c' },
    });

    assert.equal(result.width, 20);
    assert.equal(result.height, 10);
  } finally {
    await rm(template_dir, { recursive: true, force: true });
  }
});

test('an inline html source resolves relative local assets against its base_dir', async () => {
  const fixture = await make_test_image({ size: '32x32' });

  try {
    const render_with = async (src, dir) => {
      const result = await service.render({
        source: { html: `<html><body style="margin:0;background:#fff"><img src="${src}" style="width:32px;height:32px"></body></html>`, base_dir: fixture.dir },
        format: { width: 32, height: 32, device_scale_factor: 1 },
        output: { filename: 'inline.png', dir },
      });

      const { readFile } = await import('fs/promises');
      return (await readFile(result.local_path)).toString('base64');
    };

    // base_dir is a plain filesystem path — it has to become a file:// URL, or
    // the <base href> is unusable and the local file origin never gets primed.
    assert.notEqual(
      await render_with('./test.png', 'job_inline_ok'),
      await render_with('./does-not-exist.png', 'job_inline_missing'),
      'an inline template referencing a real local image must render differently than one referencing a missing file',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('rejects with UNKNOWN_FORMAT for an unrecognized format string', async () => {
  await assert.rejects(
    service.render({
      source: { html: '<html></html>' },
      format: 'not_a_real_format',
      output: { filename: 'x.png', dir: 'job_d' },
    }),
    error => { assert.equal(error.code, 'UNKNOWN_FORMAT'); return true; },
  );
});
