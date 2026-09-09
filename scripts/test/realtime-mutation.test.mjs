import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipAcknowledgedRealtimeEvent } from '../../apps/web/src/realtime-policy.ts';

const event = {
  schemaVersion: 1,
  entity: 'note',
  action: 'updated',
  noteId: 'note-a',
  version: 4,
  updatedAt: '2026-09-09T00:00:00.000Z',
  sourceDeviceId: 'device-a',
  mutationId: 'mutation-a',
};

test('an acknowledged own mutation does not trigger a duplicate Realtime refresh', () => {
  assert.equal(shouldSkipAcknowledgedRealtimeEvent(event, 'device-a', (mutationId) => mutationId === 'mutation-a'), true);
});

test('unacknowledged own and acknowledged remote mutations still flow through Realtime recovery', () => {
  assert.equal(shouldSkipAcknowledgedRealtimeEvent(event, 'device-a', () => false), false);
  assert.equal(shouldSkipAcknowledgedRealtimeEvent({ ...event, sourceDeviceId: 'device-b' }, 'device-a', () => true), false);
});
