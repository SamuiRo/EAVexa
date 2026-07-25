import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import RenderJobBuilder from '../src/modules/jobs/render_job_builder.js';

test('build_render_job does not create the output directory as a side effect (B9)', () => {
  const output_dir = path.join(tmpdir(), `eavexa-test-output-${Date.now()}`);
  const inputs_dir = path.join(tmpdir(), `eavexa-test-inputs-${Date.now()}`);
  const builder    = new RenderJobBuilder({ inputs_dir, output_dir });
  const job_output_dir = path.join(output_dir, 'demo_job');

  try {
    assert.equal(existsSync(job_output_dir), false);

    builder.build_render_job({
      id: 'demo_job', template: 'template.html', output: 'out.png', format: 'story',
    });

    assert.equal(
      existsSync(job_output_dir),
      false,
      'RenderJobBuilder must not mkdir eagerly — directories are created lazily at write time',
    );
  } finally {
    rmSync(output_dir, { recursive: true, force: true });
  }
});
