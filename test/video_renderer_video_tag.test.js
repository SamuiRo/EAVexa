import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import VideoRenderer from '../src/modules/renderer/video_renderer.js';
import { make_test_video } from './support/test_video.js';

let renderer;
let fixture;
let work_dir;

before(async () => {
  renderer = new VideoRenderer({ settle_ms: 0 });
  await renderer.connect();
  fixture  = await make_test_video({ duration: 1, fps: 4, size: '32x32' });
  work_dir = await mkdtemp(path.join(os.tmpdir(), 'eavexa-video-tag-test-'));
});

after(async () => {
  await renderer.close();
  await fixture.cleanup();
  await rm(work_dir, { recursive: true, force: true });
});

function html_with_video(extra_attr = '') {
  return `<html><body style="margin:0;width:32px;height:32px;overflow:hidden">
    <video src="${fixture.url}" ${extra_attr} style="width:32px;height:32px;object-fit:cover"></video>
  </body></html>`;
}

async function distinct_frame_count(html) {
  const output_path = path.join(work_dir, `${Math.random().toString(36).slice(2)}.mp4`);

  const result = await renderer.render_html(html, output_path, { width: 32, height: 32, device_scale_factor: 1 }, {
    video: { duration: 1, fps: 4, keep_frames: true },
  });

  const frames_dir = result.frames_dir;
  const files       = (await readdir(frames_dir)).sort();
  const buffers     = await Promise.all(files.map(name => readFile(path.join(frames_dir, name))));
  const unique      = new Set(buffers.map(buffer => buffer.toString('base64')));

  await rm(frames_dir, { recursive: true, force: true });
  await rm(output_path, { force: true });

  return { total: files.length, unique: unique.size };
}

test('<video> elements are seeked per-frame during video rendering, producing distinct frames', async () => {
  const { total, unique } = await distinct_frame_count(html_with_video());

  assert.equal(total, 4);
  assert.ok(unique > 1, 'expected frames to differ once the video is seeked per captured frame');
});

test('data-eavexa-skip opts a <video> out of automatic per-frame seeking', async () => {
  const { total, unique } = await distinct_frame_count(html_with_video('data-eavexa-skip'));

  assert.equal(total, 4);
  assert.equal(unique, 1, 'a skipped video should never be touched, so every frame stays identical');
});
