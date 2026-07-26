import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { read_png_size } from '../support/png_size.js';

const exec_file = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('../../src/cli/cli.js', import.meta.url));

function run_cli(args, opts = {}) {
  return exec_file(process.execPath, [CLI_PATH, ...args], { encoding: 'utf-8', ...opts });
}

test('render --json prints exactly one JSON result line to stdout, logs go to stderr', async () => {
  const work_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-cli-render-'));

  try {
    const template_path = path.join(work_dir, 'tpl.html');
    await writeFile(template_path, '<html><body style="margin:0;background:#000"><h1>{{TITLE}}</h1></body></html>', 'utf-8');
    const out_path = path.join(work_dir, 'out.png');

    const { stdout, stderr } = await run_cli([
      'render', '--file', template_path, '--format', '300x200@1', '--var', 'TITLE=Hi', '-o', out_path, '--json',
    ]);

    const lines = stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'stdout must contain exactly one line');

    const result = JSON.parse(lines[0]);
    assert.equal(result.type, 'image');
    assert.equal(result.width, 300);
    assert.equal(result.height, 200);
    assert.equal(result.local_path, out_path);

    assert.match(stderr, /Rendering/);

    const png = await readFile(out_path);
    assert.deepEqual(read_png_size(png), { width: 300, height: 200 });
  } finally {
    await rm(work_dir, { recursive: true, force: true });
  }
});

test('render -o - streams raw PNG bytes to stdout with no other stdout output', async () => {
  const work_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-cli-render-'));

  try {
    const template_path = path.join(work_dir, 'tpl.html');
    await writeFile(template_path, '<html><body style="margin:0;background:#fff"></body></html>', 'utf-8');

    const { stdout } = await run_cli(
      ['render', '--file', template_path, '--format', '80x60@1', '-o', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 },
    );

    assert.deepEqual(read_png_size(stdout), { width: 80, height: 60 });
  } finally {
    await rm(work_dir, { recursive: true, force: true });
  }
});

test('render --dry-run prints the normalized request and writes nothing', async () => {
  const work_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-cli-render-'));

  try {
    const template_path = path.join(work_dir, 'tpl.html');
    await writeFile(template_path, '<html><body>{{TITLE}}</body></html>', 'utf-8');

    const { stdout } = await run_cli([
      'render', '--file', template_path, '--format', 'story', '--var', 'TITLE=X', '--dry-run', '--json',
    ]);

    const request = JSON.parse(stdout);
    assert.equal(request.source.kind, 'file');
    assert.equal(request.format.key, 'story');
    assert.equal(request.vars.TITLE, 'X');
  } finally {
    await rm(work_dir, { recursive: true, force: true });
  }
});

test('render exits with code 2 and a structured error for an unknown format', async () => {
  const work_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-cli-render-'));

  try {
    const template_path = path.join(work_dir, 'tpl.html');
    await writeFile(template_path, '<html></html>', 'utf-8');

    await assert.rejects(
      run_cli(['render', '--file', template_path, '--format', 'not_a_format', '--json']),
      error => {
        assert.equal(error.code, 2);
        const payload = JSON.parse(error.stderr.trim().split('\n').pop());
        assert.equal(payload.error.code, 'UNKNOWN_FORMAT');
        return true;
      },
    );
  } finally {
    await rm(work_dir, { recursive: true, force: true });
  }
});

test('render exits with code 2 when no source flag is given', async () => {
  await assert.rejects(
    run_cli(['render', '--format', 'story', '--json']),
    error => { assert.equal(error.code, 2); return true; },
  );
});

test('templates list --json returns an array', async () => {
  const { stdout } = await run_cli(['templates', 'list', '--json']);
  assert.ok(Array.isArray(JSON.parse(stdout)));
});

test('formats --json includes the "story" preset', async () => {
  const { stdout } = await run_cli(['formats', '--json']);
  const entries = JSON.parse(stdout);
  assert.ok(entries.some(entry => entry.key === 'story'));
});

test('unknown command exits with code 2', async () => {
  await assert.rejects(run_cli(['not-a-real-command']), error => { assert.equal(error.code, 2); return true; });
});
