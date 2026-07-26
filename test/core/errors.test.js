import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RenderError, is_known_error_code } from '../../src/core/errors.js';

test('RenderError attaches the documented http_status/exit_code for a known code', () => {
  const error = new RenderError('MISSING_REQUIRED_VAR', 'Template requires var "TITLE"', { var: 'TITLE' });

  assert.equal(error.code, 'MISSING_REQUIRED_VAR');
  assert.equal(error.http_status, 400);
  assert.equal(error.exit_code, 2);
  assert.equal(error.message, 'Template requires var "TITLE"');
  assert.deepEqual(error.details, { var: 'TITLE' });
  assert.ok(error instanceof Error);
});

test('RenderError falls back to INTERNAL for an unknown code rather than throwing', () => {
  const error = new RenderError('NOT_A_REAL_CODE', 'oops');

  assert.equal(error.code, 'INTERNAL');
  assert.equal(error.http_status, 500);
  assert.equal(error.exit_code, 1);
});

test('is_known_error_code distinguishes real codes from made-up ones', () => {
  assert.equal(is_known_error_code('RENDER_TIMEOUT'), true);
  assert.equal(is_known_error_code('NOT_A_REAL_CODE'), false);
});

test('toJSON produces a stable wire shape', () => {
  const error = new RenderError('QUEUE_FULL', 'Render queue is full', { queue_max: 100 });
  assert.deepEqual(error.toJSON(), {
    code: 'QUEUE_FULL', message: 'Render queue is full', details: { queue_max: 100 },
  });
});
