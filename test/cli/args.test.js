import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse_args, as_array } from '../../src/cli/args.js';

test('parses --flag value pairs', () => {
  const args = parse_args(['--template', 'promo', '--format', 'story']);
  assert.equal(args.template, 'promo');
  assert.equal(args.format, 'story');
});

test('parses --flag=value', () => {
  const args = parse_args(['--format=story']);
  assert.equal(args.format, 'story');
});

test('applies short aliases', () => {
  const args = parse_args(['-t', 'promo', '-o', './out.png'], { aliases: { t: 'template', o: 'out' } });
  assert.equal(args.template, 'promo');
  assert.equal(args.out, './out.png');
});

test('treats declared booleans as flags with no value', () => {
  const args = parse_args(['--json', '--offline'], { booleans: ['json', 'offline'] });
  assert.equal(args.json, true);
  assert.equal(args.offline, true);
});

test('infers a boolean when the next token looks like another flag', () => {
  const args = parse_args(['--dry-run', '--format', 'story']);
  assert.equal(args['dry-run'], true);
  assert.equal(args.format, 'story');
});

test('collects a repeated flag into an array', () => {
  const args = parse_args(['--var', 'A=1', '--var', 'B=2']);
  assert.deepEqual(args.var, ['A=1', 'B=2']);
});

test('as_array normalizes single/array/absent values', () => {
  assert.deepEqual(as_array(undefined), []);
  assert.deepEqual(as_array('A=1'), ['A=1']);
  assert.deepEqual(as_array(['A=1', 'B=2']), ['A=1', 'B=2']);
});

test('-- stops flag parsing and collects the remainder as positionals', () => {
  const args = parse_args(['render', '--', '--not-a-flag', 'literal']);
  assert.deepEqual(args._, ['render', '--not-a-flag', 'literal']);
});

test('bare positionals are collected in order', () => {
  const args = parse_args(['show', 'promo', '--json']);
  assert.deepEqual(args._, ['show', 'promo']);
  assert.equal(args.json, true);
});
