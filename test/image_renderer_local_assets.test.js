import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'url';
import path from 'path';
import ImageRenderer from '../src/modules/renderer/image_renderer.js';
import { make_test_image } from './support/test_image.js';

describe('image_renderer_local_assets', () => {
  let renderer;
  let fixture;
  let base_url;

  before(async () => {
    renderer = new ImageRenderer({ settle_ms: 0 });
    await renderer.connect();
    fixture  = await make_test_image({ size: '32x32' });
    base_url = pathToFileURL(fixture.dir + path.sep).href;
  });

  after(async () => {
    await renderer.close();
    await fixture.cleanup();
  });

  function html_with_image(src) {
    return `<html><body style="margin:0;width:32px;height:32px;overflow:hidden;background:#fff">
      <img src="${src}" style="width:32px;height:32px;object-fit:cover">
    </body></html>`;
  }

  test('a relative local <img src> resolved via base_url actually loads (regression: file:// origin)', async () => {
    const format = { width: 32, height: 32, device_scale_factor: 1 };

    const loaded_png = await renderer.render_html(html_with_image('./test.png'), format, { base_url });
    const broken_png  = await renderer.render_html(html_with_image('./does-not-exist.png'), format, { base_url });

    assert.notEqual(
      loaded_png.toString('base64'),
      broken_png.toString('base64'),
      'a template referencing a real local image must render differently than one referencing a missing file',
    );
  });
});
