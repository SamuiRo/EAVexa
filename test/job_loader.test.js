import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import JobLoader from '../src/modules/jobs/job_loader.js';

function write_jobs_file(dir, jobs) {
  const jobs_file = path.join(dir, 'jobs.json');
  writeFileSync(jobs_file, JSON.stringify({ jobs }), 'utf-8');
  return jobs_file;
}

test('rejects an image job with a non-image output extension (B10)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eavexa-jobloader-'));

  try {
    const jobs_file = write_jobs_file(dir, [
      { id: 'bad', template: 't.html', output: 'out.gif', format: 'story' },
    ]);

    await assert.rejects(
      () => new JobLoader({ jobs_file }).load_jobs(),
      /image jobs must be/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts a .png image job', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eavexa-jobloader-'));

  try {
    const jobs_file = write_jobs_file(dir, [
      { id: 'ok', template: 't.html', output: 'out.png', format: 'story' },
    ]);

    const jobs = await new JobLoader({ jobs_file }).load_jobs();
    assert.equal(jobs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
