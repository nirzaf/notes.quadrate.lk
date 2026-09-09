import test from 'node:test';
import assert from 'node:assert/strict';
import { noteQueryKeys, refreshNoteViews } from '../../apps/web/src/note-query-keys.ts';

function recordingQueryClient() {
  const calls = [];
  return {
    calls,
    invalidateQueries: async (filters) => {
      calls.push(filters);
    },
  };
}

function hasQueryKey(calls, expected) {
  return calls.filter(({ queryKey }) => JSON.stringify(queryKey) === JSON.stringify(expected)).length;
}

test('refreshing note A targets concrete collection/search families and only note A detail', async () => {
  const userId = 'user-a';
  const keys = noteQueryKeys.forUser(userId);
  const queryClient = recordingQueryClient();

  await refreshNoteViews(queryClient, userId, 'note-a');

  for (const queryKey of [keys.homeFamily, keys.sidebarFamily, keys.trashFamily, keys.searchFamily, keys.note('note-a')]) {
    assert.equal(hasQueryKey(queryClient.calls, queryKey), 1);
  }
  assert.equal(hasQueryKey(queryClient.calls, keys.all), 0);
  assert.equal(hasQueryKey(queryClient.calls, keys.note('note-b')), 0);
  const contextFilter = queryClient.calls.find(({ predicate }) => predicate);
  assert.ok(contextFilter);
  assert.equal(contextFilter.predicate({ queryKey: keys.searchContext('document-a'), state: { data: { noteId: 'note-a' } } }), true);
  assert.equal(contextFilter.predicate({ queryKey: keys.searchContext('document-b'), state: { data: { noteId: 'note-b' } } }), false);
});
