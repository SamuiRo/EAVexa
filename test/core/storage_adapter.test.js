import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { createHash } from 'crypto';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import StorageAdapter from '../../src/core/storage_adapter.js';

test('put() writes atomically to an explicit dir, with checksum and meta.json', async () => {
  const output_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-storage-'));

  try {
    const storage = new StorageAdapter({ output_dir });
    const buffer  = Buffer.from('hello world');

    const stored = await storage.put(buffer, { job_id: 'j1', filename: 'out.png', dir: 'j1' });

    const expected_path = path.join(output_dir, 'j1', 'out.png');
    assert.equal(stored.local_path, expected_path);
    assert.equal(stored.bytes, buffer.length);
    assert.equal(stored.checksum, `sha256:${createHash('sha256').update(buffer).digest('hex')}`);
    assert.equal(stored.storage, 'local');
    assert.equal(existsSync(expected_path), true);
    assert.equal(existsSync(`${expected_path}.part`), false, 'the .part temp file must not survive a successful write');

    const meta = JSON.parse(await readFile(`${expected_path}.meta.json`, 'utf-8'));
    assert.equal(meta.checksum, stored.checksum);
  } finally {
    await rm(output_dir, { recursive: true, force: true });
  }
});

test('put() without an explicit dir falls back to a dated/job_id layout', async () => {
  const output_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-storage-'));

  try {
    const storage = new StorageAdapter({ output_dir });
    const stored  = await storage.put(Buffer.from('x'), { job_id: 'j2', filename: 'out.png' });

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(stored.local_path, path.join(output_dir, today, 'j2', 'out.png'));
  } finally {
    await rm(output_dir, { recursive: true, force: true });
  }
});

test('finalize() adopts an already-written temp file and computes its checksum', async () => {
  const output_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-storage-out-'));
  const temp_dir    = await mkdtemp(path.join(tmpdir(), 'eavexa-storage-tmp-'));

  try {
    const temp_path = path.join(temp_dir, 'encoded.mp4');
    const content    = Buffer.from('fake mp4 bytes');
    await writeFile(temp_path, content);

    const storage = new StorageAdapter({ output_dir });
    const stored  = await storage.finalize(temp_path, { job_id: 'j3', filename: 'promo.mp4', dir: 'j3' });

    assert.equal(stored.bytes, content.length);
    assert.equal(stored.checksum, `sha256:${createHash('sha256').update(content).digest('hex')}`);
    assert.equal(existsSync(path.join(output_dir, 'j3', 'promo.mp4')), true);
    assert.equal(existsSync(temp_path), false, 'the source temp file must be gone after finalize (renamed away)');
  } finally {
    await rm(output_dir, { recursive: true, force: true });
    await rm(temp_dir, { recursive: true, force: true });
  }
});

test('translate_path rewrites OUTPUT_DIR to OUTPUT_DIR_ALIAS for a downstream consumer', async () => {
  const output_dir = path.join('S:', 'data', 'outputs');
  const storage = new StorageAdapter({ output_dir, output_dir_alias: '/data/outputs' });

  const abs_path = path.join(output_dir, 'job1', 'out.png');
  assert.equal(storage.translate_path(abs_path), '/data/outputs/job1/out.png');
});

test('translate_path is a no-op without an alias', () => {
  const storage = new StorageAdapter({ output_dir: 'S:\\out', output_dir_alias: null });
  assert.equal(storage.translate_path('S:\\out\\a\\b.png'), 'S:\\out\\a\\b.png');
});
