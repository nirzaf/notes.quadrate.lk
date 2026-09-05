import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUpdateLastUsedAt } from './auth-telemetry.ts';

test('updates last_used_at only for missing, stale, or malformed timestamps', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');

  assert.equal(shouldUpdateLastUsedAt('2026-09-05T11:59:00.000Z', now), false, 'recent timestamps skip telemetry');
  assert.equal(shouldUpdateLastUsedAt('2026-09-05T11:55:00.000Z', now), true, 'five-minute-old timestamps update telemetry');
  assert.equal(shouldUpdateLastUsedAt(null, now), true, 'missing timestamps update telemetry');
  assert.equal(shouldUpdateLastUsedAt('2026-09-05T11:54:59.999Z', now), true, 'old timestamps update telemetry');
  assert.equal(shouldUpdateLastUsedAt('not-a-timestamp', now), true, 'malformed timestamps update telemetry');
});
