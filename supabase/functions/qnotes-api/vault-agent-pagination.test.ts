import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAllRangePages } from './vault-agent-pagination.ts';

test('fetchAllRangePages requests every bounded range until the first short page', async () => {
  const source = Array.from({ length: 1_001 }, (_, index) => index);
  const ranges: Array<[number, number]> = [];
  const rows = await fetchAllRangePages(async (from, to) => {
    ranges.push([from, to]);
    return source.slice(from, to + 1);
  });

  assert.deepEqual(ranges, [[0, 499], [500, 999], [1_000, 1_499]]);
  assert.deepEqual(rows, source);
});
