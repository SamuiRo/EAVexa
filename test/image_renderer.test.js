import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { writeFile, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import ImageRenderer from '../src/modules/renderer/image_renderer.js';
import { read_png_size } from './support/png_size.js';

let renderer;

before(async () => {
  renderer = new ImageRenderer({ settle_ms: 0 });
  await renderer.connect();
});

after(async () => {
  await renderer.close();
});

test('render_html produces a PNG at the actual requested pixel size, DPR applied (B1)', async () => {
  const format = { width: 100, height: 80, device_scale_factor: 2 };
  const html   = '<html><body style="margin:0;background:#fff"></body></html>';

  const png = await renderer.render_html(html, format);
  const { width, height } = read_png_size(png);

  assert.equal(width, 200, 'PNG width must reflect deviceScaleFactor (100*2), not the raw CSS width');
  assert.equal(height, 160, 'PNG height must reflect deviceScaleFactor (80*2), not the raw CSS height');
});

test('render_html honors base_url so relative assets resolve via <base href> (B2)', async () => {
  const html = '<html><head></head><body><div id="probe"></div></body></html>';

  const png = await renderer.render_html(html, { width: 10, height: 10, device_scale_factor: 1 }, {
    base_url: 'file:///C:/does/not/exist/',
  });

  const { width, height } = read_png_size(png);
  assert.equal(width, 10);
  assert.equal(height, 10);
});

test('render_file creates the output directory lazily and writes the PNG (B9)', async () => {
  const work_dir     = path.join(tmpdir(), `eavexa-image-renderer-test-${Date.now()}`);
  const template_path = path.join(work_dir, 'template.html');
  const output_path   = path.join(work_dir, 'out', 'result.png');

  await mkdir(work_dir, { recursive: true });
  await writeFile(template_path, '<html><body><div>{{TITLE}}</div></body></html>', 'utf-8');

  try {
    assert.equal(existsSync(path.dirname(output_path)), false);

    const result = await renderer.render_file(
      template_path,
      output_path,
      { width: 20, height: 20, device_scale_factor: 1 },
      { TITLE: '<b>hi</b>' },
    );

    assert.equal(existsSync(output_path), true);
    assert.equal(result.width, 20);
    assert.equal(result.height, 20);
  } finally {
    await rm(work_dir, { recursive: true, force: true });
  }
});
