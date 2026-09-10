import test from 'node:test';
import assert from 'node:assert/strict';
import { noteQueryKeys } from '../../apps/web/src/note-query-keys.ts';
import { runSyncRecovery } from '../../apps/web/src/sync-recovery-core.ts';

function recordingQueryClient(events = []) {
  const calls = [];
  return {
    calls,
    invalidateQueries: async ({ queryKey }) => {
      events.push(['invalidate', queryKey]);
      calls.push(queryKey);
    },
  };
}

function hasQueryKey(calls, expected) {
  return calls.filter((queryKey) => JSON.stringify(queryKey) === JSON.stringify(expected)).length;
}

function change(noteId, deletedAt = null) {
  return { noteId, deletedAt };
}

test('recovery batches repeated IDs across pages and invalidates after the final cursor is stored', async () => {
  const userId = 'user-a';
  const keys = noteQueryKeys.forUser(userId);
  const events = [];
  const queryClient = recordingQueryClient(events);
  const syncCursors = [];
  const pages = [
    { changes: [change('note-a')], nextCursor: 'cursor-1', hasMore: true },
    { changes: [change('note-b'), change('note-a', '2026-09-09T00:00:00.000Z')], nextCursor: 'cursor-2', hasMore: false },
  ];
  const removed = [];
  let pageIndex = 0;

  await runSyncRecovery({
    userId,
    queryClient,
    api: { sync: async (cursor) => { syncCursors.push(cursor); return pages[pageIndex++]; } },
    readSyncCursor: async () => 'cursor-0',
    writeSyncCursor: async (cursor) => { events.push(['write', cursor]); },
    removeRememberedNote: async (noteId) => { removed.push(noteId); },
    generation: 0,
    getGeneration: () => 0,
    signal: new AbortController().signal,
  });

  assert.deepEqual(syncCursors, ['cursor-0', 'cursor-1']);
  assert.deepEqual(removed, ['note-a']);
  assert.deepEqual(events.filter(([kind]) => kind === 'write'), [['write', 'cursor-2']]);
  assert.ok(events.findIndex(([kind]) => kind === 'write') < events.findIndex(([kind]) => kind === 'invalidate'));
  for (const queryKey of [keys.homeFamily, keys.sidebarFamily, keys.trashFamily, keys.searchFamily, keys.notebooks]) assert.equal(hasQueryKey(queryClient.calls, queryKey), 1);
  assert.equal(hasQueryKey(queryClient.calls, keys.note('note-a')), 1);
  assert.equal(hasQueryKey(queryClient.calls, keys.note('note-b')), 1);
});

test('recovery keeps the latest deletion state when a later page restores the note', async () => {
  const queryClient = recordingQueryClient();
  const removed = [];
  let pageIndex = 0;
  const pages = [
    { changes: [change('note-a', '2026-09-09T00:00:00.000Z')], nextCursor: 'cursor-1', hasMore: true },
    { changes: [change('note-a')], nextCursor: 'cursor-2', hasMore: false },
  ];

  await runSyncRecovery({
    userId: 'user-a',
    queryClient,
    api: { sync: async () => pages[pageIndex++] },
    readSyncCursor: async () => 'cursor-0',
    writeSyncCursor: async () => {},
    removeRememberedNote: async (noteId) => { removed.push(noteId); },
    generation: 0,
    getGeneration: () => 0,
    signal: new AbortController().signal,
  });

  assert.deepEqual(removed, []);
});

test('incremental no-change recovery stores its cursor without unconditional list or search invalidation', async () => {
  const queryClient = recordingQueryClient();
  let syncCount = 0;
  let writtenCursor = null;

  await runSyncRecovery({
    userId: 'user-a',
    queryClient,
    api: { sync: async (cursor) => { syncCount += 1; return { changes: [], nextCursor: cursor ?? null, hasMore: false }; } },
    readSyncCursor: async () => 'cursor-existing',
    writeSyncCursor: async (cursor) => { writtenCursor = cursor; },
    removeRememberedNote: async () => {},
    generation: 0,
    getGeneration: () => 0,
    signal: new AbortController().signal,
  });

  assert.equal(syncCount, 1);
  assert.equal(writtenCursor, 'cursor-existing');
  assert.deepEqual(queryClient.calls, []);
});

test('first/reset recovery still reconciles collections when there are no changes', async () => {
  const userId = 'user-a';
  const keys = noteQueryKeys.forUser(userId);
  const queryClient = recordingQueryClient();

  await runSyncRecovery({
    userId,
    queryClient,
    api: { sync: async () => ({ changes: [], nextCursor: null, hasMore: false }) },
    readSyncCursor: async () => null,
    writeSyncCursor: async () => {},
    removeRememberedNote: async () => {},
    generation: 0,
    getGeneration: () => 0,
    signal: new AbortController().signal,
  });

  for (const queryKey of [keys.homeFamily, keys.sidebarFamily, keys.trashFamily, keys.searchFamily]) assert.equal(hasQueryKey(queryClient.calls, queryKey), 1);
});

test('policy-invalidated recovery clears remembered notes and restarts from the current scope', async () => {
  const userId = 'user-a';
  const keys = noteQueryKeys.forUser(userId);
  const queryClient = recordingQueryClient();
  const syncCursors = [];
  const writes = [];
  let cleared = 0;
  let attempt = 0;

  await runSyncRecovery({
    userId,
    queryClient,
    api: { sync: async (cursor) => {
      syncCursors.push(cursor);
      if (attempt++ === 0) throw { status: 422, code: 'VALIDATION_ERROR', message: 'cursor is invalid or expired.' };
      return { changes: [], nextCursor: null, hasMore: false };
    } },
    readSyncCursor: async () => 'revoked-scope-cursor',
    writeSyncCursor: async (cursor) => { writes.push(cursor); },
    removeRememberedNote: async () => {},
    clearRememberedNotes: async () => { cleared += 1; },
    generation: 0,
    getGeneration: () => 0,
    signal: new AbortController().signal,
  });

  assert.deepEqual(syncCursors, ['revoked-scope-cursor', undefined]);
  assert.deepEqual(writes, [null, null]);
  assert.equal(cleared, 1);
  assert.ok(queryClient.calls.some((queryKey) => JSON.stringify(queryKey) === JSON.stringify(keys.root)));
  for (const queryKey of [keys.homeFamily, keys.sidebarFamily, keys.trashFamily, keys.searchFamily]) assert.equal(hasQueryKey(queryClient.calls, queryKey), 1);
});

test('recovery stops before cursor advancement or invalidation when its generation becomes stale', async () => {
  const events = [];
  const queryClient = recordingQueryClient(events);
  let currentGeneration = 0;

  await runSyncRecovery({
    userId: 'user-a',
    queryClient,
    api: { sync: async () => { currentGeneration = 1; return { changes: [change('note-a')], nextCursor: 'cursor-1', hasMore: false }; } },
    readSyncCursor: async () => 'cursor-0',
    writeSyncCursor: async () => { events.push(['write']); },
    removeRememberedNote: async () => { events.push(['remove']); },
    generation: 0,
    getGeneration: () => currentGeneration,
    signal: new AbortController().signal,
  });

  assert.deepEqual(events, []);
  assert.deepEqual(queryClient.calls, []);
});

test('recovery still invalidates account-scoped views when generation changes during cursor persistence', async () => {
  const userId = 'user-a';
  const keys = noteQueryKeys.forUser(userId);
  const queryClient = recordingQueryClient();
  let currentGeneration = 0;
  let releaseWrite;
  let resolveWriteStarted;
  const writeStarted = new Promise((resolve) => { resolveWriteStarted = resolve; });
  const writeRelease = new Promise((resolve) => { releaseWrite = resolve; });

  const recovery = runSyncRecovery({
    userId,
    queryClient,
    api: { sync: async () => ({ changes: [change('note-a')], nextCursor: 'cursor-1', hasMore: false }) },
    readSyncCursor: async () => 'cursor-0',
    writeSyncCursor: async () => {
      resolveWriteStarted();
      await writeRelease;
    },
    removeRememberedNote: async () => {},
    generation: 0,
    getGeneration: () => currentGeneration,
    signal: new AbortController().signal,
  });

  await writeStarted;
  currentGeneration = 1;
  releaseWrite();
  await recovery;

  for (const queryKey of [keys.homeFamily, keys.sidebarFamily, keys.trashFamily, keys.searchFamily, keys.notebooks, keys.note('note-a')]) {
    assert.ok(queryClient.calls.some((called) => JSON.stringify(called) === JSON.stringify(queryKey)));
  }
});

test('page application stores content before advancing its checkpoint', async () => {
  const events = [];
  const note = { id: 'note-a', title: 'A', contentMarkdown: '# A', contentPlain: 'A' };
  await runSyncRecovery({
    userId: 'user-a',
    queryClient: recordingQueryClient(),
    api: {
      sync: async () => ({ changes: [{ noteId: 'note-a', deletedAt: null }], nextCursor: 'cursor-1', hasMore: false }),
      getNote: async () => { events.push('fetch'); return note; },
    },
    readSyncCursor: async () => 'cursor-0',
    writeSyncCursor: async () => { throw new Error('legacy cursor write must not be used'); },
    removeRememberedNote: async () => { throw new Error('legacy delete must not be used'); },
    applySyncPage: async (page) => { events.push(['apply', page.notes[0].id, page.cursor]); },
    generation: 0,
    getGeneration: () => 0,
    signal: new AbortController().signal,
  });
  assert.deepEqual(events, ['fetch', ['apply', 'note-a', 'cursor-1']]);
});

test('classifies a fetched deleted note as a tombstone before page application', async () => {
  const applied = [];
  await runSyncRecovery({
    userId: 'user-a',
    queryClient: recordingQueryClient(),
    api: {
      sync: async () => ({ changes: [change('note-a')], nextCursor: 'cursor-1', hasMore: false }),
      getNote: async () => ({ id: 'note-a', deletedAt: '2026-09-09T00:00:00.000Z' }),
    },
    readSyncCursor: async () => 'cursor-0',
    writeSyncCursor: async () => { throw new Error('legacy cursor write must not be used'); },
    removeRememberedNote: async () => { throw new Error('legacy delete must not be used'); },
    applySyncPage: async (page) => { applied.push(page); },
    generation: 0,
    getGeneration: () => 0,
    signal: new AbortController().signal,
  });
  assert.deepEqual(applied, [{ notes: [], deletedNoteIds: ['note-a'], cursor: 'cursor-1' }]);
});
