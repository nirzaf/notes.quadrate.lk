import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexedDbDraftStore, MemoryDraftStore } from '../../packages/sync/src/drafts.ts';

const megabyte = 1024 * 1024;

function note(id, version = 1, overrides = {}) {
  return {
    id,
    slug: `note-${id}`,
    title: `Note ${id}`,
    contentMarkdown: `# ${id}`,
    contentPlain: id,
    tags: ['test'],
    notebookId: null,
    version,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: `2026-09-09T00:00:0${Math.min(version, 9)}.000Z`,
    deletedAt: null,
    ...overrides,
  };
}

async function snapshotsIn(store) {
  const records = await store.listRecent(1000);
  const values = [];
  for (const record of records) {
    const snapshot = await store.getNoteSnapshot(record.id);
    if (snapshot) values.push(snapshot);
  }
  return values;
}

test('only complete same-account non-deleted note records are snapshot cache hits', async () => {
  const cases = [
    { name: 'summary-only', value: { noteId: 'note-a', id: 'note-a', title: 'Summary', version: 1, updatedAt: '2026-09-09T00:00:00.000Z' } },
    { name: 'partial', value: { ...note('note-a'), contentPlain: undefined } },
    { name: 'corrupt', value: { ...note('note-a'), tags: 'test' } },
    { name: 'deleted', value: { ...note('note-a'), deletedAt: '2026-09-09T00:00:01.000Z' } },
    { name: 'mismatched', lookup: 'note-b', value: { ...note('note-a'), id: 'note-b', noteId: 'note-a' } },
  ];

  for (const { name, lookup = 'note-a', value } of cases) {
    const store = new MemoryDraftStore();
    await store.putRecent(value);
    assert.equal(await store.getNoteSnapshot(lookup), null, `${name} record must be a cache miss`);
  }

  const store = new MemoryDraftStore();
  const expected = note('note-a');
  await store.putNoteSnapshot(expected);
  assert.deepEqual(await store.getNoteSnapshot('note-a'), expected);
});

test('late older reads cannot replace a newer snapshot', async () => {
  const store = new MemoryDraftStore();
  const newer = note('note-a', 3);
  const older = note('note-a', 2);

  await store.putNoteSnapshot(newer);
  await store.putNoteSnapshot(older);

  assert.equal((await store.getNoteSnapshot('note-a')).version, 3);
});

test('snapshot retention is bounded by count and serialized data while drafts survive', async () => {
  const store = new MemoryDraftStore();
  const draft = {
    noteId: 'draft-note',
    baseVersion: 1,
    baseMarkdown: 'base',
    localMarkdown: 'local',
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
  await store.put(draft);

  for (let index = 0; index < 55; index += 1) {
    await store.putNoteSnapshot(note(`note-${index}`, index + 1));
  }

  const byCount = await snapshotsIn(store);
  assert.equal(byCount.length, 50);
  assert.equal(byCount.some((value) => value.id === 'note-0'), false);
  assert.equal(byCount.some((value) => value.id === 'note-54'), true);
  assert.deepEqual(await store.get('draft-note'), draft);

  const largeStore = new MemoryDraftStore();
  await largeStore.putNoteSnapshot(note('large-a', 1, { contentMarkdown: 'a'.repeat(4 * megabyte) }));
  await largeStore.putNoteSnapshot(note('large-b', 2, { contentMarkdown: 'b'.repeat(4 * megabyte) }));
  await largeStore.putNoteSnapshot(note('large-c', 3, { contentMarkdown: 'c'.repeat(4 * megabyte) }));
  const retained = await snapshotsIn(largeStore);
  const serializedBytes = retained.reduce((total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0);
  assert.ok(serializedBytes <= 10 * megabyte);
});

test('account stores remain isolated and unavailable IndexedDB is a cache miss without hiding writes', async () => {
  const accountA = new MemoryDraftStore();
  const accountB = new MemoryDraftStore();
  await accountA.putNoteSnapshot(note('same-note', 1, { contentMarkdown: 'account A' }));
  assert.equal(await accountB.getNoteSnapshot('same-note'), null);

  const unavailable = new IndexedDbDraftStore('qnotes-test-storage-failure');
  assert.equal(await unavailable.getNoteSnapshot('same-note'), null);
  await assert.rejects(() => unavailable.putNoteSnapshot(note('same-note')), /Local storage is unavailable/);
});

test('deleting a remembered note removes its snapshot without touching its draft', async () => {
  const store = new MemoryDraftStore();
  await store.putNoteSnapshot(note('note-a'));
  await store.put({ noteId: 'note-a', baseVersion: 1, baseMarkdown: 'base', localMarkdown: 'draft', updatedAt: '2026-09-09T00:00:00.000Z' });

  await store.deleteRecent('note-a');

  assert.equal(await store.getNoteSnapshot('note-a'), null);
  assert.equal((await store.get('note-a')).localMarkdown, 'draft');
});
