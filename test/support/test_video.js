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

  // A data: URL, not file://, because Chromium refuses to load local file://
  // resources from a page whose content came from page.setContent() (no
  // file:// origin of its own) — the same restriction that applies to any
  // local asset referenced by a rendered template.
  const bytes    = await readFile(output_path);
  const data_url = `data:video/mp4;base64,${bytes.toString('base64')}`;

  return {
    path:    output_path,
    url:     data_url,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
