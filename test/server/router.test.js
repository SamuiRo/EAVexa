import { test } from 'node:test';
import assert from 'node:assert/strict';
import Router from '../../src/server/router.js';

test('matches an exact path', () => {
  const router = new Router();
  router.get('/v1/formats', () => 'formats');

  const match = router.match('GET', '/v1/formats');
  assert.equal(match.handler(), 'formats');
  assert.deepEqual(match.params, {});
});

test('extracts :param segments', () => {
  const router = new Router();
  router.get('/v1/jobs/:id', (req, res, params) => params);

  const match = router.match('GET', '/v1/jobs/j_123');
  assert.deepEqual(match.params, { id: 'j_123' });
});

test('extracts multiple :param segments', () => {
  const router = new Router();
  router.get('/v1/a/:x/b/:y', (req, res, params) => params);

  const match = router.match('GET', '/v1/a/foo/b/bar');
  assert.deepEqual(match.params, { x: 'foo', y: 'bar' });
});

test('decodes URI-encoded param values', () => {
  const router = new Router();
  router.get('/v1/templates/:name', (req, res, params) => params);

  const match = router.match('GET', '/v1/templates/my%20template');
  assert.equal(match.params.name, 'my template');
});

test('returns null for a path that matches nothing', () => {
  const router = new Router();
  router.get('/v1/formats', () => {});

  assert.equal(router.match('GET', '/v1/nope'), null);
});

test('flags method_not_allowed when the path matches but not the method', () => {
  const router = new Router();
  router.get('/v1/jobs/:id', () => {});

  const match = router.match('DELETE', '/v1/jobs/j_123');
  assert.equal(match.method_not_allowed, true);
});

test('does not confuse a static segment with a similarly-shaped dynamic one', () => {
  const router = new Router();
  router.get('/v1/jobs/:id/result', () => 'result');
  router.get('/v1/jobs/:id', () => 'job');

  assert.equal(router.match('GET', '/v1/jobs/j_1/result').handler(), 'result');
  assert.equal(router.match('GET', '/v1/jobs/j_1').handler(), 'job');
});
