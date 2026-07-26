import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, rename, copyFile, unlink, chmod, writeFile, stat } from 'fs/promises';
import path from 'path';
import { RenderError } from './errors.js';
import { OUTPUT_DIR, OUTPUT_DIR_ALIAS } from '../config/app_config.js';

function date_dir() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function safe_rename(src, dest) {
  try {
    await rename(src, dest);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;

    // Cross-device: fall back to copy + delete (not atomic, but the only option).
    await copyFile(src, dest);
    await unlink(src);
  }
}

function hash_file(file_path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file_path);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Writes render artifacts to local disk: dated/job_id layout by default (or
 * an explicit dir), atomic `<file>.part` -> rename, streamed SHA-256
 * checksum, 0644 perms, and a `<file>.meta.json` sidecar.
 * See docs/specification.md §3 and §5.8.
 */
export default class StorageAdapter {
  constructor({ output_dir = OUTPUT_DIR, output_dir_alias = OUTPUT_DIR_ALIAS } = {}) {
    this.output_dir       = output_dir;
    this.output_dir_alias = output_dir_alias;
  }

  /**
   * Compute the on-disk layout for an artifact without writing anything.
   */
  plan({ job_id, filename, dir }) {
    const target_dir = dir
      ? path.resolve(this.output_dir, dir)
      : path.join(this.output_dir, date_dir(), job_id);

    return {
      dir:        target_dir,
      final_path: path.join(target_dir, filename),
      part_path:  path.join(target_dir, `${filename}.part`),
    };
  }

  /**
   * Write an in-memory buffer as an artifact (used by the image renderer).
   * @returns {Promise<Object>} StoredArtifact
   */
  async put(buffer, opts) {
    const { dir, final_path, part_path } = this.plan(opts);

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(part_path, buffer);
    } catch (error) {
      throw new RenderError('STORAGE_FAILED', `Cannot write artifact: ${error.message}`, { path: part_path });
    }

    const checksum = createHash('sha256').update(buffer).digest('hex');

    return this._commit(part_path, final_path, checksum, buffer.length);
  }

  /**
   * Adopt an already-written temp file as the artifact (used by the video
   * renderer, which writes the encoded file directly via FFmpeg).
   * @returns {Promise<Object>} StoredArtifact
   */
  async finalize(temp_path, opts) {
    const { dir, final_path, part_path } = this.plan(opts);

    let bytes;
    let checksum;

    try {
      ({ size: bytes } = await stat(temp_path));
      checksum = await hash_file(temp_path);
      await mkdir(dir, { recursive: true });
      await safe_rename(temp_path, part_path);
    } catch (error) {
      throw new RenderError('STORAGE_FAILED', `Cannot store artifact: ${error.message}`, { path: final_path });
    }

    return this._commit(part_path, final_path, checksum, bytes);
  }

  /**
   * @returns {null} No HTTP server exists until Крок 4 — nothing to link to yet.
   */
  build_public_url() {
    return null;
  }

  /**
   * Translate a real local path to the alias a remote consumer (e.g. n8n in
   * a container) would see, per OUTPUT_DIR_ALIAS.
   */
  translate_path(abs_path) {
    if (!this.output_dir_alias || !abs_path.startsWith(this.output_dir)) {
      return abs_path;
    }

    const rel = path.relative(this.output_dir, abs_path);
    return path.posix.join(this.output_dir_alias, ...rel.split(path.sep));
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  async _commit(part_path, final_path, checksum, bytes) {
    try {
      await chmod(part_path, 0o644);
      await safe_rename(part_path, final_path);
    } catch (error) {
      throw new RenderError('STORAGE_FAILED', `Cannot finalize artifact: ${error.message}`, { path: final_path });
    }

    const stored = {
      storage:    'local',
      local_path: final_path,
      path:       this.translate_path(final_path),
      bytes,
      checksum:   `sha256:${checksum}`,
      url:        null,
    };

    // Minimal sidecar for now — a full result mirror (for recovery without a
    // JobStore) is completed once job_store.js lands in Крок 3.
    await writeFile(`${final_path}.meta.json`, JSON.stringify(stored, null, 2), 'utf-8');

    return stored;
  }
}
