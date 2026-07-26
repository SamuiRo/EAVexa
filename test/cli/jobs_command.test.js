import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import path from 'path';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const exec_file = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('../../src/cli/cli.js', import.meta.url));

function start_receiver() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => { res.writeHead(200); res.end('ok'); });
    });
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('render --callback-url then jobs list/show/stats/prune round-trip via the real CLI', async () => {
  const work_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-cli-jobs-'));
  const job_store_dir = path.join(work_dir, 'jobs');
  const output_dir = path.join(work_dir, 'out');
  const receiver = await start_receiver();

  const env = { ...process.env, JOB_STORE_DIR: job_store_dir, OUTPUT_DIR: output_dir };

  function run_cli(args) {
    return exec_file(process.execPath, [CLI_PATH, ...args], { encoding: 'utf-8', env });
  }

  try {
    const template_path = path.join(work_dir, 'tpl.html');
    await writeFile(template_path, '<html><body style="margin:0;background:#000"></body></html>', 'utf-8');

    const render_out = await run_cli([
      'render', '--file', template_path, '--format', '20x10@1',
      '-o', path.join(work_dir, 'async.png'), '--callback-url', receiver.url, '--json',
    ]);

    const job_record = JSON.parse(render_out.stdout);
    assert.equal(job_record.status, 'done');
    assert.equal(job_record.callback.state, 'delivered');

    const list_out = await run_cli(['jobs', 'list', '--json']);
    const jobs = JSON.parse(list_out.stdout);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, job_record.id);

    const show_out = await run_cli(['jobs', 'show', job_record.id]);
    assert.equal(JSON.parse(show_out.stdout).id, job_record.id);

    const stats_out = await run_cli(['jobs', 'stats', '--json']);
    const stats = JSON.parse(stats_out.stdout);
    assert.equal(stats.total, 1);
    assert.equal(stats.by_status.done, 1);

    const dry_prune = await run_cli(['jobs', 'prune', '--dry-run', '--json']);
    const dry_result = JSON.parse(dry_prune.stdout);
    assert.equal(dry_result.dry_run, true);
    assert.equal(dry_result.pruned, 1);

    const still_there = JSON.parse((await run_cli(['jobs', 'list', '--json'])).stdout);
    assert.equal(still_there.length, 1, '--dry-run must not actually remove anything');

    const real_prune = await run_cli(['jobs', 'prune', '--json']);
    assert.equal(JSON.parse(real_prune.stdout).pruned, 1);

    const after_prune = JSON.parse((await run_cli(['jobs', 'list', '--json'])).stdout);
    assert.equal(after_prune.length, 0);
  } finally {
    await close(receiver.server);
    await rm(work_dir, { recursive: true, force: true });
  }
});

test('jobs show exits with JOB_NOT_FOUND for an unknown id', async () => {
  const work_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-cli-jobs-'));
  const env = { ...process.env, JOB_STORE_DIR: path.join(work_dir, 'jobs'), OUTPUT_DIR: path.join(work_dir, 'out') };

  try {
    await assert.rejects(
      exec_file(process.execPath, [CLI_PATH, 'jobs', 'show', 'j_doesnotexist'], { encoding: 'utf-8', env }),
      error => { assert.equal(error.code, 2); return true; },
    );
  } finally {
    await rm(work_dir, { recursive: true, force: true });
  }
});
