import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ImageRenderer from '../src/modules/renderer/image_renderer.js';
import { read_png_size } from './support/png_size.js';
import { make_test_video } from './support/test_video.js';

let renderer;
let fixture;

before(async () => {
  renderer = new ImageRenderer({ settle_ms: 0, video_timeout_ms: 3000 });
  await renderer.connect();
  fixture  = await make_test_video({ duration: 1, fps: 4, size: '32x32' });
});

after(async () => {
  await renderer.close();
  await fixture.cleanup();
});

test('image jobs freeze an autoplaying <video> instead of hanging or racing playback (video tag support)', async () => {
  const html = `<html><body style="margin:0;width:32px;height:32px;overflow:hidden">
    <video src="${fixture.url}" autoplay muted loop style="width:32px;height:32px;object-fit:cover"></video>
  </body></html>`;

  const png = await renderer.render_html(html, { width: 32, height: 32, device_scale_factor: 1 });
  const { width, height } = read_png_size(png);

  assert.equal(width, 32);
  assert.equal(height, 32);
});

test('data-eavexa-skip leaves a <video> element untouched for image jobs too', async () => {
  const html = `<html><body style="margin:0;width:32px;height:32px;overflow:hidden">
    <video src="${fixture.url}" data-eavexa-skip style="width:32px;height:32px;object-fit:cover"></video>
  </body></html>`;

  const png = await renderer.render_html(html, { width: 32, height: 32, device_scale_factor: 1 });
  const { width, height } = read_png_size(png);

  assert.equal(width, 32);
  assert.equal(height, 32);
});
