import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDraft } from '../dist/index.js';

const note = (overrides = {}) => ({
  id: 'note-1',
  slug: 'note-1',
  title: 'Base title',
  contentMarkdown: 'base\noriginal\nremote',
  contentPlain: 'base remote',
  tags: ['base', 'remote'],
  notebookId: 'notebook-base',
  version: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:04.000Z',
  deletedAt: null,
  ...overrides,
});

const draft = (overrides = {}) => ({
  noteId: 'note-1',
  baseVersion: 3,
  baseMarkdown: 'base\noriginal',
  localMarkdown: 'base\nlocal',
  baseTitle: 'Base title',
  localTitle: 'Local title',
  baseTags: ['base'],
  localTags: ['base', 'local'],
  baseNotebookId: 'notebook-base',
  localNotebookId: 'notebook-local',
  updatedAt: '2026-01-01T00:00:03.000Z',
  ...overrides,
});

test('reconciles independent body, title, tag, and notebook changes', () => {
  const result = reconcileDraft(draft(), note());
  assert.deepEqual(result, {
    status: 'clean',
    values: {
      markdown: 'base\nlocal\nremote',
      title: 'Local title',
      tags: ['base', 'local', 'remote'],
      notebookId: 'notebook-local',
    },
    conflicts: [],
  });
});

test('keeps overlapping edits in review state', () => {
  const result = reconcileDraft({ ...draft(), localMarkdown: 'base\nchanged\nend' }, note({ contentMarkdown: 'base\nremote changed\nend' }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'body');
});

test('preserves drafts based on a newer or inconsistent version', () => {
  assert.equal(reconcileDraft({ ...draft(), baseVersion: 0 }, note()).reason, 'invalid-base');
  assert.equal(reconcileDraft({ ...draft(), baseVersion: 5 }, note()).reason, 'newer-base');
  assert.equal(reconcileDraft({ ...draft(), baseVersion: 4, baseMarkdown: 'unexpected' }, note()).reason, 'base-mismatch');
});

test('preserves drafts when the remote note was deleted', () => {
  const result = reconcileDraft(draft(), note({ deletedAt: '2026-01-01T00:00:05.000Z' }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'remote-deleted');
  assert.equal(result.values.markdown, 'base\nlocal');
});

test('treats tag deletion and reordering as conflicts', () => {
  assert.equal(reconcileDraft({ ...draft(), localTags: ['local', 'base'] }, note()).reason, 'tags');
  assert.equal(reconcileDraft({ ...draft(), localTags: [] }, note()).reason, 'tags');
});

test('keeps an explicit null notebook change instead of treating it as absent', () => {
  const result = reconcileDraft({ ...draft(), baseNotebookId: 'notebook-old', localNotebookId: null }, note({ notebookId: 'notebook-remote' }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'notebook');
  assert.equal(result.values.notebookId, null);
});
