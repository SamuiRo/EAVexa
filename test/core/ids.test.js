import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate_id, new_render_id, new_job_id, new_delivery_id } from '../../src/core/ids.js';

test('generate_id prefixes the ID as given', () => {
  assert.match(generate_id('x_'), /^x_[0-9A-Z]+$/);
});

test('new_render_id/new_job_id/new_delivery_id use the documented prefixes', () => {
  assert.match(new_render_id(), /^r_/);
  assert.match(new_job_id(), /^j_/);
  assert.match(new_delivery_id(), /^d_/);
});

test('IDs generated in sequence sort in call order (monotonic)', () => {
  const ids = Array.from({ length: 50 }, () => new_render_id());
  const sorted = [...ids].sort();

  assert.deepEqual(ids, sorted, 'string sort order must match generation order');
});

test('IDs are unique across many calls in the same tick', () => {
  const ids = new Set(Array.from({ length: 200 }, () => new_render_id()));
  assert.equal(ids.size, 200);
});
