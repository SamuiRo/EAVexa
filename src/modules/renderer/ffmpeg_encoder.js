import { spawn }       from 'child_process';
import path            from 'path';
import ffmpeg_static_path from 'ffmpeg-static';
import { FFMPEG_PATH } from '../../config/app_config.js';
import { VIDEO_OUTPUT_EXTENSIONS } from '../../config/video_config.js';

/**
 * Encodes PNG frame sequences into video files through FFmpeg.
 */
export default class FfmpegEncoder {
  constructor(options = {}) {
    this.ffmpeg_path = options.ffmpeg_path
      ?? FFMPEG_PATH
      ?? ffmpeg_static_path
      ?? 'ffmpeg';
  }

  /**
   * Encode frame_000000.png style frames into a video file.
   *
   * @param {Object} options
   * @param {string} options.frames_dir
   * @param {string} options.output_path
   * @param {number} options.fps
   * @param {number} [options.crf]
   * @param {string} [options.preset]
   * @returns {Promise<{ output_path: string, container: string, ffmpeg_path: string }>}
   */
  async encode_frames(options) {
    try {
      const container = this._get_container(options.output_path);
      const args      = this._build_args(container, options);

      await this._run_ffmpeg(args);

      return {
        output_path: options.output_path,
        container,
        ffmpeg_path: this.ffmpeg_path,
      };
    } catch (error) {
      throw new Error(`Video encode failed: ${error.message}`);
    }
  }

  _get_container(output_path) {
    const container = path.extname(output_path).toLowerCase();

    if (!VIDEO_OUTPUT_EXTENSIONS.includes(container)) {
      throw new Error(
        `Unsupported video format "${container}". Supported: ${VIDEO_OUTPUT_EXTENSIONS.join(', ')}`,
      );
    }

    return container;
  }

  _build_args(container, options) {
    const fps           = String(options.fps);
    const input_pattern = path.join(options.frames_dir, 'frame_%06d.png');
    const codec_args    = this._build_codec_args(container, options);

    return [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-framerate', fps,
      '-start_number', '0',
      '-i', input_pattern,
      ...codec_args,
      options.output_path,
    ];
  }

  _build_codec_args(container, options) {
    const crf    = String(options.crf ?? 18);
    const preset = options.preset ?? 'medium';

    if (container === '.webm') {
      return [
        '-c:v', 'libvpx-vp9',
        '-b:v', '0',
        '-crf', String(options.webm_crf ?? 32),
        '-deadline', 'good',
        '-cpu-used', '2',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-pix_fmt', 'yuv420p',
      ];
    }

    const args = [
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', crf,
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p',
    ];

    if (container === '.mp4' || container === '.mov') {
      args.push('-movflags', '+faststart');
    }

    return args;
  }

  _run_ffmpeg(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg_path, args, {
        windowsHide: true,
      });

      let stderr = '';

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('error', error => {
        reject(new Error(`Cannot start FFmpeg at "${this.ffmpeg_path}": ${error.message}`));
      });

      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`));
          return;
        }

        resolve();
      });
    });
  }
}
