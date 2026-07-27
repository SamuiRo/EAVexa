import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import VideoRenderer from '../src/modules/renderer/video_renderer.js';
import { dominant_channel } from './support/png_pixels.js';
import { make_test_video, make_two_tone_video } from './support/test_video.js';

const FORMAT = { width: 32, height: 32, device_scale_factor: 1 };

let renderer;
let fixture;
let two_tone;
let work_dir;

before(async () => {
  renderer = new VideoRenderer({ settle_ms: 0 });
  await renderer.connect();
  fixture  = await make_test_video({ duration: 1, fps: 4, size: '32x32' });
  two_tone = await make_two_tone_video({ duration: 2, size: '32x32' });
  work_dir = await mkdtemp(path.join(os.tmpdir(), 'eavexa-video-tag-test-'));
});

after(async () => {
  await renderer.close();
  await fixture.cleanup();
  await two_tone.cleanup();
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

/**
 * Render the two-tone fixture and report each frame as 'red' (clip first half)
 * or 'blue' (clip second half), which pins down the exact seek position.
 */
async function frame_colours(html, video_options) {
  const output_path = path.join(work_dir, `${Math.random().toString(36).slice(2)}.mp4`);

  const result = await renderer.render_html(html, output_path, FORMAT, {
    video: { ...video_options, keep_frames: true },
  });

  const files   = (await readdir(result.frames_dir)).sort();
  const colours = [];

  for (const name of files) {
    colours.push(await dominant_channel(await readFile(path.join(result.frames_dir, name))));
  }

  await rm(result.frames_dir, { recursive: true, force: true });
  await rm(output_path, { force: true });

  return colours;
}

function html_with_two_tone() {
  return `<html><body style="margin:0;width:32px;height:32px;overflow:hidden;background:#00ff00">
    <video src="${two_tone.url}" muted style="width:32px;height:32px;object-fit:cover"></video>
  </body></html>`;
}

test('a <video> as long as the render does not wrap back to its first frame at the end', async () => {
  // 2s clip, 2s render at 2fps → frame times 0, 0.5, 1.0, 1.5 → red red blue blue.
  // Seeking on `time_s` instead of `frame_time_s` would stretch these to
  // 0, 0.667, 1.333, 2.0 and wrap the last frame (2.0 % 2 === 0) back to red.
  const colours = await frame_colours(html_with_two_tone(), { duration: 2, fps: 2 });

  assert.deepEqual(colours, ['red', 'red', 'blue', 'blue']);
});

test('a <video> shorter than the render loops over its own duration', async () => {
  // 2s clip, 4s render at 2fps → frame times 0, 0.5 … 3.5 → the clip plays twice.
  const colours = await frame_colours(html_with_two_tone(), { duration: 4, fps: 2 });

  assert.deepEqual(colours, ['red', 'red', 'blue', 'blue', 'red', 'red', 'blue', 'blue']);
});

test('a preload="none" <video> is loaded rather than left blank for every frame', async () => {
  const html = `<html><body style="margin:0;width:32px;height:32px;overflow:hidden;background:#00ff00">
    <video src="${two_tone.url}" preload="none" muted style="width:32px;height:32px;object-fit:cover"></video>
  </body></html>`;

  const colours = await frame_colours(html, { duration: 2, fps: 2 });

  assert.deepEqual(
    colours,
    ['red', 'red', 'blue', 'blue'],
    'preload="none" must be upgraded so duration is known and frames paint, instead of showing bare background',
  );
});
