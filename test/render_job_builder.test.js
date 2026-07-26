import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import RenderJobBuilder from '../src/modules/jobs/render_job_builder.js';

test('build_render_job builds a raw render request pointing at the job template, no side effects (B9)', () => {
  const inputs_dir = path.join(tmpdir(), `eavexa-test-inputs-${Date.now()}`);
  const builder    = new RenderJobBuilder({ inputs_dir });

  const request = builder.build_render_job({
    id: 'demo_job', template: 'template.html', output: 'out.png', format: 'story', vars: { A: '1' },
  });

  assert.deepEqual(request, {
    source: { path: path.join(inputs_dir, 'demo_job', 'template.html') },
    format: 'story',
    vars: { A: '1' },
    video: null,
    output: { filename: 'out.png', dir: 'demo_job' },
    metadata: { job_id: 'demo_job' },
  });

  assert.equal(
    existsSync(inputs_dir),
    false,
    'RenderJobBuilder must not create any directory as a side effect — storage_adapter creates dirs lazily at write time',
  );
});

test('build_render_jobs maps every job through build_render_job', () => {
  const builder = new RenderJobBuilder({ inputs_dir: path.join(tmpdir(), 'eavexa-test-inputs-batch') });

  const requests = builder.build_render_jobs([
    { id: 'a', template: 't.html', output: 'a.png', format: 'story' },
    { id: 'b', template: 't.html', output: 'b.mp4', format: 'story', video: { duration: 2 } },
  ]);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].output.dir, 'a');
  assert.deepEqual(requests[1].video, { duration: 2 });
});
