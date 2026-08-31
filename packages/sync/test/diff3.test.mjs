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

test('returns required markers for overlapping conflicts', () => {
  const result = threeWayMerge('one\ntwo\nthree', 'one\nLOCAL\nthree', 'one\nREMOTE\nthree');
  assert.equal(result.status, 'conflict');
  assert.match(result.merged, /<<<<<<< LOCAL/);
  assert.match(result.merged, /\|\|\|\|\|\|\| BASE/);
  assert.match(result.merged, /=======/);
  assert.match(result.merged, />\>\>\>\>\>\> REMOTE/);
  assert.equal(result.conflicts.length, 1);
});
