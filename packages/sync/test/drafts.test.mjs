import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDraftStore } from '../dist/index.js';

const note = (overrides = {}) => ({
  id: 'note-1',
  slug: 'note-1',
  title: 'Cached note',
  contentMarkdown: '# Cached note\n\nneedle',
  contentPlain: 'Cached note needle',
  tags: ['cache'],
  notebookId: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  deletedAt: null,
  ...overrides,
});

test('keeps bodies out of recent summaries and hides deleted cached notes from search', async () => {
  const store = new MemoryDraftStore();
  await store.putRecent(note());
  await store.applySyncPage({ notes: [note({ id: 'note-2', slug: 'note-2', updatedAt: '2026-01-01T00:00:03.000Z' })], deletedNoteIds: [], cursor: 'cursor-1' });
  await store.putRecent(note({ id: 'deleted', slug: 'deleted', deletedAt: '2026-01-01T00:00:02.000Z' }));

  const recent = await store.listRecent();
  assert.ok(recent.every((item) => !('contentMarkdown' in item) && !('contentPlain' in item)));
  assert.deepEqual((await store.searchRecent('needle')).map((item) => item.id), ['note-2', 'note-1']);
  assert.deepEqual(await store.searchRecent('cached'), [recent.find((item) => item.id === 'note-2') ?? null, recent.find((item) => item.id === 'note-1') ?? null]);
});
