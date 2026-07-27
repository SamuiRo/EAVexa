import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import ffmpeg_path from 'ffmpeg-static';

/**
 * Generates a short synthetic test pattern video (moving bars, distinct
 * frame-to-frame content) via the bundled ffmpeg-static binary, so video-tag
 * tests don't need a checked-in binary fixture.
 */
export async function make_test_video({ duration = 1, fps = 4, size = '32x32' } = {}) {
  const dir         = await mkdtemp(path.join(os.tmpdir(), 'eavexa-video-fixture-'));
  const output_path = path.join(dir, 'test.mp4');

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg_path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=${size}:rate=${fps}`,
      '-pix_fmt', 'yuv420p',
      output_path,
    ]);

    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });

  // A data: URL so the fixture works with no base_url at all — local file://
  // assets need the template's own file:// origin to be primed first, which is
  // covered separately by test/image_renderer_local_assets.test.js.
  const bytes    = await readFile(output_path);
  const data_url = `data:video/mp4;base64,${bytes.toString('base64')}`;

  return {
    path:    output_path,
    url:     data_url,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Generates a clip that is solid red for its first half and solid blue for its
 * second, so a rendered frame's colour says exactly where in the clip the
 * video was seeked to. Used to assert looping and per-frame seek positions.
 *
 * @param {Object} [options]
 * @param {number} [options.duration]  Total clip length in seconds
 * @returns {Promise<{ path: string, url: string, duration: number, cleanup: Function }>}
 */
export async function make_two_tone_video({ duration = 2, size = '32x32' } = {}) {
  const dir         = await mkdtemp(path.join(os.tmpdir(), 'eavexa-two-tone-fixture-'));
  const output_path = path.join(dir, 'two_tone.mp4');
  const half        = duration / 2;

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg_path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=red:s=${size}:d=${half}:r=25`,
      '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=${half}:r=25`,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[out]',
      '-map', '[out]',
      '-pix_fmt', 'yuv420p',
      output_path,
    ]);

    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });

  const bytes = await readFile(output_path);

  return {
    path:     output_path,
    url:      `data:video/mp4;base64,${bytes.toString('base64')}`,
    duration,
    cleanup:  () => rm(dir, { recursive: true, force: true }),
  };
}
