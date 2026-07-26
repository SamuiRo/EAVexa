import { mkdir, readFile, writeFile, rename, rm, readdir } from 'fs/promises';
import path from 'path';
import { RenderError } from './errors.js';
import { decode_id_time } from './ids.js';
import { file_exists } from '../shared/utils.js';
import { JOB_STORE_DIR, JOB_CACHE_SIZE } from '../config/app_config.js';

class LRUCache {
  constructor(max_size) {
    this.max_size = max_size;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;

    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value); // refresh recency
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);

    if (this.map.size > this.max_size) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  delete(key) {
    this.map.delete(key);
  }
}

/**
 * One JSON file per job, sharded by creation date, atomic `.tmp` -> rename.
 * No global index — `list()` scans date directories newest-first and stops
 * once `limit` is satisfied. See docs/specification.md §5.9 and §3.
 */
export default class FileJobStore {
  constructor({ dir = JOB_STORE_DIR, cache_size = JOB_CACHE_SIZE } = {}) {
    this.dir = dir;
    this.cache = new LRUCache(cache_size);
  }

  async create(job) {
    await this._write(job);
    this.cache.set(job.id, job);
    return job;
  }

  async get(id) {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const file_path = await this._locate(id);
    if (!file_path) return null;

    const job = JSON.parse(await readFile(file_path, 'utf-8'));
    this.cache.set(id, job);
    return job;
  }

  async update(id, patch) {
    const current = await this.get(id);

    if (!current) {
      throw new RenderError('JOB_NOT_FOUND', `Job "${id}" was not found`, { job_id: id });
    }

    const updated = { ...current, ...patch };
    await this._write(updated);
    this.cache.set(id, updated);
    return updated;
  }

  async remove(id) {
    const file_path = await this._locate(id);
    if (!file_path) return;

    await rm(file_path, { force: true });
    await rm(file_path.replace(/\.json$/, '.html'), { force: true });
    this.cache.delete(id);
  }

  /**
   * @param {{ status?: string, before?: string, after?: string, limit?: number }} [opts]
   * @returns {Promise<Array<Object>>} Newest-first.
   */
  async list({ status, before, after, limit = 50 } = {}) {
    const results = [];

    for (const date_dir of await this._date_dirs_desc()) {
      for (const file of await this._job_files_desc(date_dir)) {
        const id = path.basename(file, '.json');

        if (before && id >= before) continue;
        if (after && id <= after) continue;

        const job = await this.get(id);
        if (!job) continue;
        if (status && job.status !== status) continue;

        results.push(job);
        if (results.length >= limit) return results;
      }
    }

    return results;
  }

  /**
   * Jobs with a webhook still waiting on a scheduled retry — resumed at startup.
   */
  async pending_callbacks() {
    const all = await this._all_jobs();
    return all.filter(job => job.callback?.state === 'pending');
  }

  /**
   * Jobs left in 'queued'/'running' by a process that died mid-render.
   */
  async orphaned_running() {
    const all = await this._all_jobs();
    return all.filter(job => job.status === 'queued' || job.status === 'running');
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  async _write(job) {
    const dir = path.join(this.dir, this._date_dir_for(job.id));
    await mkdir(dir, { recursive: true });

    const file_path = path.join(dir, `${job.id}.json`);
    const tmp_path = `${file_path}.tmp`;

    await writeFile(tmp_path, JSON.stringify(job, null, 2), 'utf-8');
    await rename(tmp_path, file_path);
  }

  _date_dir_for(id) {
    const ts = decode_id_time(id);
    return ts !== null ? new Date(ts).toISOString().slice(0, 10) : 'unknown';
  }

  async _locate(id) {
    const guess = path.join(this.dir, this._date_dir_for(id), `${id}.json`);
    if (await file_exists(guess)) return guess;

    for (const date_dir of await this._date_dirs_desc()) {
      const candidate = path.join(this.dir, date_dir, `${id}.json`);
      if (await file_exists(candidate)) return candidate;
    }

    return null;
  }

  async _date_dirs_desc() {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
    } catch {
      return [];
    }
  }

  async _job_files_desc(date_dir) {
    try {
      const entries = await readdir(path.join(this.dir, date_dir));
      return entries.filter(name => name.endsWith('.json')).sort().reverse();
    } catch {
      return [];
    }
  }

  async _all_jobs() {
    const all = [];

    for (const date_dir of await this._date_dirs_desc()) {
      for (const file of await this._job_files_desc(date_dir)) {
        const job = await this.get(path.basename(file, '.json'));
        if (job) all.push(job);
      }
    }

    return all;
  }
}
