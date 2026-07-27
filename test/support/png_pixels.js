import { spawn } from 'child_process';
import ffmpeg_path from 'ffmpeg-static';

/**
 * Decode a PNG to raw RGB via the bundled ffmpeg-static binary and return the
 * mean colour. Lets video-tag tests assert on what was actually painted
 * instead of only on the output dimensions.
 *
 * @param {Buffer} png
 * @returns {Promise<{ r: number, g: number, b: number }>}
 */
export async function mean_rgb(png) {
  const raw = await decode_rgb24(png);

  let r = 0;
  let g = 0;
  let b = 0;

  for (let offset = 0; offset < raw.length; offset += 3) {
    r += raw[offset];
    g += raw[offset + 1];
    b += raw[offset + 2];
  }

  const pixels = raw.length / 3;

  return { r: r / pixels, g: g / pixels, b: b / pixels };
}

/**
 * Classify a PNG's mean colour as the dominant primary — 'red', 'green',
 * 'blue', or 'none' when nothing dominates. Test fixtures use saturated
 * primaries precisely so this stays unambiguous.
 *
 * @param {Buffer} png
 * @returns {Promise<'red'|'green'|'blue'|'none'>}
 */
export async function dominant_channel(png) {
  const { r, g, b } = await mean_rgb(png);

  if (r > 200 && g < 80 && b < 80) return 'red';
  if (g > 200 && r < 80 && b < 80) return 'green';
  if (b > 200 && r < 80 && g < 80) return 'blue';

  return 'none';
}

function decode_rgb24(png) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg_path, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      'pipe:1',
    ]);

    const chunks = [];
    let stderr = '';

    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(`ffmpeg failed to decode PNG: ${stderr}`))));

    child.stdin.on('error', () => {});
    child.stdin.end(png);
  });
}
