import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import FileJobStore from '../../src/core/job_store.js';
import { new_job_id } from '../../src/core/ids.js';

async function make_store(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eavexa-jobstore-'));
  return { store: new FileJobStore({ dir, ...overrides }), dir };
}

test('create() + get() round-trips a job record atomically (no .tmp left behind)', async () => {
  const { store, dir } = await make_store();

  try {
    const id = new_job_id();
    await store.create({ id, status: 'queued' });

    const fetched = await store.get(id);
    assert.equal(fetched.status, 'queued');

    const date_dir = (await readdir(dir))[0];
    const files = await readdir(path.join(dir, date_dir));
    assert.deepEqual(files, [`${id}.json`], 'only the final file should exist, no .tmp');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('get() finds a job on disk even after the in-memory cache is bypassed', async () => {
  const { store, dir } = await make_store();

  try {
    const id = new_job_id();
    await store.create({ id, status: 'queued' });

    const fresh_store = new FileJobStore({ dir }); // simulates a new process
    const fetched = await fresh_store.get(id);
    assert.equal(fetched.status, 'queued');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('update() merges a patch and persists it', async () => {
  const { store, dir } = await make_store();

  try {
    const id = new_job_id();
    await store.create({ id, status: 'queued', progress: { ratio: 0 } });
    const updated = await store.update(id, { status: 'running' });

    assert.equal(updated.status, 'running');
    assert.deepEqual(updated.progress, { ratio: 0 }, 'unpatched fields must survive the merge');

    const fresh_store = new FileJobStore({ dir });
    assert.equal((await fresh_store.get(id)).status, 'running');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('update() throws JOB_NOT_FOUND for a missing job', async () => {
  const { store, dir } = await make_store();

  try {
    await assert.rejects(
      store.update(new_job_id(), { status: 'done' }),
      error => { assert.equal(error.code, 'JOB_NOT_FOUND'); return true; },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remove() deletes the job file', async () => {
  const { store, dir } = await make_store();

  try {
    const id = new_job_id();
    await store.create({ id, status: 'done' });
    await store.remove(id);

    assert.equal(await store.get(id), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list() returns newest-first and supports status filtering + limit', async () => {
  const { store, dir } = await make_store();

  try {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const id = new_job_id();
      ids.push(id);
      await store.create({ id, status: i % 2 === 0 ? 'done' : 'failed' });
    }

    const all = await store.list({ limit: 100 });
    assert.deepEqual(all.map(job => job.id), [...ids].reverse());

    const done_only = await store.list({ status: 'done', limit: 100 });
    assert.ok(done_only.every(job => job.status === 'done'));

    const limited = await store.list({ limit: 2 });
    assert.equal(limited.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pending_callbacks() returns only jobs with callback.state === "pending"', async () => {
  const { store, dir } = await make_store();

  try {
    await store.create({ id: new_job_id(), status: 'done', callback: { state: 'delivered' } });
    const pending_id = new_job_id();
    await store.create({ id: pending_id, status: 'done', callback: { state: 'pending' } });
    await store.create({ id: new_job_id(), status: 'done', callback: null });

    const pending = await store.pending_callbacks();
    assert.deepEqual(pending.map(job => job.id), [pending_id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('orphaned_running() returns jobs stuck in queued/running', async () => {
  const { store, dir } = await make_store();

  try {
    const running_id = new_job_id();
    const queued_id = new_job_id();
    await store.create({ id: running_id, status: 'running' });
    await store.create({ id: queued_id, status: 'queued' });
    await store.create({ id: new_job_id(), status: 'done' });

    const orphaned = await store.orphaned_running();
    assert.deepEqual(new Set(orphaned.map(job => job.id)), new Set([running_id, queued_id]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('LRU cache evicts the oldest entry beyond cache_size', async () => {
  const { store, dir } = await make_store({ cache_size: 2 });

  try {
    const id_a = new_job_id();
    const id_b = new_job_id();
    const id_c = new_job_id();

    await store.create({ id: id_a, status: 'done' });
    await store.create({ id: id_b, status: 'done' });
    await store.create({ id: id_c, status: 'done' }); // evicts id_a from cache

    assert.equal(store.cache.get(id_a), undefined);
    assert.ok(store.cache.get(id_b));
    assert.ok(store.cache.get(id_c));

    // still reachable via disk fallback
    assert.ok(await store.get(id_a));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
