import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import path from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { sign_result_token } from '../../src/core/result_token.js';

describe('auth', () => {
  const CLI_PATH = fileURLToPath(new URL('../../src/cli/cli.js', import.meta.url));
  const API_KEY = 'test-secret-key';

  let work_dir, child, base_url;

  before(async () => {
    work_dir = await mkdtemp(path.join(tmpdir(), 'eavexa-auth-'));
    await mkdir(path.join(work_dir, 'templates', 'greet'), { recursive: true });
    await writeFile(path.join(work_dir, 'templates', 'greet', 'template.html'), '<html><body style="margin:0;background:#000"></body></html>', 'utf-8');

    const port = 39217; // fixed — this test owns its own process, no port-0 discovery over stdio needed
    base_url = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, [CLI_PATH, 'serve', '--port', String(port)], {
      env: {
        ...process.env,
        EAVEXA_API_KEY: API_KEY,
        BUILTIN_TEMPLATES_DIR: path.join(work_dir, 'templates'),
        DATA_DIR: path.join(work_dir, 'data'),
        RESULT_TOKEN_SECRET: 'token-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await wait_for_listening(child);
  });

  after(async () => {
    child.kill();
    await rm(work_dir, { recursive: true, force: true });
  });

  function wait_for_listening(proc) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const on_data = chunk => {
        buffer += chunk.toString();
        if (buffer.includes('Listening on')) {
          proc.stdout.off('data', on_data);
          resolve();
        }
      };
      proc.stdout.on('data', on_data);
      proc.stderr.on('data', chunk => { buffer += chunk.toString(); });
      proc.on('exit', code => reject(new Error(`server exited early (code ${code}): ${buffer}`)));
      setTimeout(() => reject(new Error(`server did not start in time: ${buffer}`)), 10000);
    });
  }

  test('protected route rejects a request with no X-API-Key', async () => {
    const res = await fetch(`${base_url}/v1/jobs`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  test('protected route rejects a wrong X-API-Key', async () => {
    const res = await fetch(`${base_url}/v1/jobs`, { headers: { 'X-API-Key': 'wrong' } });
    assert.equal(res.status, 401);
  });

  test('protected route accepts the correct X-API-Key', async () => {
    const res = await fetch(`${base_url}/v1/jobs`, { headers: { 'X-API-Key': API_KEY } });
    assert.equal(res.status, 200);
  });

  test('/healthz stays open even with EAVEXA_API_KEY set', async () => {
    const res = await fetch(`${base_url}/healthz`);
    assert.equal(res.status, 200);
  });

  test('GET /v1/jobs/:id/result accepts a valid ?token= without X-API-Key', async () => {
    const render_res = await fetch(`${base_url}/v1/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ source: { name: 'greet' }, format: { width: 10, height: 10, device_scale_factor: 1 }, output: { type: 'path' } }),
    });
    const { result } = await render_res.json();

    const no_auth = await fetch(`${base_url}/v1/jobs/${result.render_id}/result`);
    assert.equal(no_auth.status, 401);

    const with_key = await fetch(`${base_url}/v1/jobs/${result.render_id}/result`, { headers: { 'X-API-Key': API_KEY } });
    assert.equal(with_key.status, 200);

    // Same secret the child process was started with — mints a token the
    // server will accept in place of X-API-Key.
    const token = sign_result_token(result.render_id, 60000, 'token-secret');
    const with_token = await fetch(`${base_url}/v1/jobs/${result.render_id}/result?token=${token}`);
    assert.equal(with_token.status, 200);

    const wrong_token = await fetch(`${base_url}/v1/jobs/${result.render_id}/result?token=not-a-real-token`);
    assert.equal(wrong_token.status, 401);
  });
});
