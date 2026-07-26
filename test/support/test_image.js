import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import ffmpeg_path from 'ffmpeg-static';

/**
 * Generates a small synthetic test-pattern PNG via the bundled ffmpeg-static
 * binary, in its own temp directory, so local-asset tests can reference it by
 * a real relative path (not a data: URL) without a checked-in fixture.
 */
export async function make_test_image({ size = '32x32' } = {}) {
  const dir         = await mkdtemp(path.join(os.tmpdir(), 'eavexa-image-fixture-'));
  const output_path = path.join(dir, 'test.png');

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg_path, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${size}`,
      '-frames:v', '1',
      output_path,
    ]);

    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });

  return {
    dir,
    path:    output_path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
