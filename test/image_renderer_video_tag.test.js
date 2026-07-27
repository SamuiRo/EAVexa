import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ImageRenderer from '../src/modules/renderer/image_renderer.js';
import { read_png_size } from './support/png_size.js';
import { dominant_channel } from './support/png_pixels.js';
import { make_two_tone_video } from './support/test_video.js';

describe('image_renderer_video_tag', () => {
  let renderer;
  let fixture;

  const FORMAT = { width: 32, height: 32, device_scale_factor: 1 };

  // The fixture is solid red for its first half and solid blue for its second,
  // so the rendered colour says exactly where in the clip the video was frozen.
  before(async () => {
    renderer = new ImageRenderer({ settle_ms: 0, video_timeout_ms: 3000 });
    await renderer.connect();
    fixture  = await make_two_tone_video({ duration: 2, size: '32x32' });
  });

  after(async () => {
    await renderer.close();
    await fixture.cleanup();
  });

  function html_with_video(attrs = '') {
    return `<html><body style="margin:0;width:32px;height:32px;overflow:hidden;background:#00ff00">
      <video src="${fixture.url}" ${attrs} style="width:32px;height:32px;object-fit:cover"></video>
    </body></html>`;
  }

  test('image jobs freeze an autoplaying <video> on its first frame', async () => {
    const png = await renderer.render_html(html_with_video('autoplay muted loop'), FORMAT);
    const { width, height } = read_png_size(png);

    assert.equal(width, 32);
    assert.equal(height, 32);
    assert.equal(
      await dominant_channel(png),
      'red',
      'a frozen video must show the clip start (red), not a later autoplayed frame (blue) or bare page background (green)',
    );
  });

  test('image jobs paint a <video> that never autoplays', async () => {
    const png = await renderer.render_html(html_with_video('muted'), FORMAT);

    assert.equal(await dominant_channel(png), 'red');
  });

  test('image jobs load a preload="none" <video> instead of timing out on a blank element', async () => {
    const started_at = Date.now();
    const png        = await renderer.render_html(html_with_video('preload="none" muted'), FORMAT);
    const elapsed    = Date.now() - started_at;

    assert.equal(
      await dominant_channel(png),
      'red',
      'preload="none" must be upgraded so the video actually paints instead of staying empty',
    );

    assert.ok(
      elapsed < renderer.video_timeout_ms,
      `expected the render to finish without burning the ${renderer.video_timeout_ms}ms video timeout, took ${elapsed}ms`,
    );
  });

  test('data-eavexa-skip leaves a <video> element untouched for image jobs too', async () => {
    const png = await renderer.render_html(html_with_video('data-eavexa-skip'), FORMAT);
    const { width, height } = read_png_size(png);

    assert.equal(width, 32);
    assert.equal(height, 32);
  });
});
