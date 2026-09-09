import test from 'node:test';
import assert from 'node:assert/strict';
import { threeWayMerge } from '../dist/index.js';

test('handles no-op, local-only, remote-only, and identical edits', () => {
  assert.deepEqual(threeWayMerge('a\nb', 'a\nb', 'a\nb'), { status: 'clean', merged: 'a\nb', conflicts: [] });
  assert.equal(threeWayMerge('a\nb', 'local\nb', 'a\nb').merged, 'local\nb');
  assert.equal(threeWayMerge('a\nb', 'a\nb', 'a\nremote').merged, 'a\nremote');
  assert.equal(threeWayMerge('a\nb', 'same\nb', 'same\nb').status, 'clean');
});

test('merges non-overlapping edits', () => {
  const result = threeWayMerge('one\ntwo\nthree\nfour', 'ONE\ntwo\nthree\nfour', 'one\ntwo\nTHREE\nfour');
  assert.deepEqual(result, { status: 'clean', merged: 'ONE\ntwo\nTHREE\nfour', conflicts: [] });
});

test('keeps disjoint edits in base order for either argument order', () => {
  const base = 'a\nb\nc';
  const local = 'a\nb\nC';
  const remote = 'A\nb\nc';
  assert.deepEqual(threeWayMerge(base, local, remote), { status: 'clean', merged: 'A\nb\nC', conflicts: [] });
  assert.deepEqual(threeWayMerge(base, remote, local), { status: 'clean', merged: 'A\nb\nC', conflicts: [] });
});

test('expands alternating overlapping hunks into one conflict region', () => {
  const result = threeWayMerge(
    'a\nb\nc\nd\ne',
    'a\nLOCAL-B\nc\nLOCAL-D\ne',
    'a\nREMOTE-B\nREMOTE-C\nREMOTE-D\ne',
  );
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    baseStartLine: 1,
    baseEndLine: 4,
    base: ['b', 'c', 'd'],
    local: ['LOCAL-B', 'c', 'LOCAL-D'],
    remote: ['REMOTE-B', 'REMOTE-C', 'REMOTE-D'],
  });
});

test('returns required markers for overlapping conflicts', () => {
  const result = threeWayMerge('one\ntwo\nthree', 'one\nLOCAL\nthree', 'one\nREMOTE\nthree');
  assert.equal(result.status, 'conflict');
  assert.match(result.merged, /<<<<<<< LOCAL/);
  assert.match(result.merged, /\|\|\|\|\|\|\| BASE/);
  assert.match(result.merged, /=======/);
  assert.match(result.merged, />\>\>\>\>\>\> REMOTE/);
  assert.equal(result.conflicts.length, 1);
});
