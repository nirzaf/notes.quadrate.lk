import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';
import { inspectWorkspaceArchive, WorkspaceArchiveError, workspaceImportConflicts, type WorkspaceBackupManifest } from './workspace-import.ts';

function duplicateArchive(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip();
    zip.ondata = (error, chunk, final) => {
      if (error) reject(error);
      else if (chunk) chunks.push(chunk);
      if (final) {
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const archive = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          archive.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(archive);
      }
    };
    for (const contents of ['{}', '{}']) {
      const file = new ZipPassThrough('manifest.json');
      zip.add(file);
      file.push(strToU8(contents), true);
    }
    zip.end();
  });
}

const manifest = {
  format: 'quadrate-notes-workspace',
  formatVersion: 2,
  backupId: '550e8400-e29b-41d4-a716-446655440000',
  exportedAt: '2026-09-06T00:00:00.000Z',
  notebooks: [],
  notes: [{ id: '550e8400-e29b-41d4-a716-446655440001', slug: 'hello', title: 'Hello', tags: [], notebookId: null, version: 1, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z', markdownPath: 'notes/hello-550e8400-e29b-41d4-a716-446655440001.md', attachments: [] }],
};

test('validates a version-two workspace archive and its byte manifest', () => {
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    [manifest.notes[0].markdownPath]: strToU8('# Hello\n'),
  });
  const inspection = inspectWorkspaceArchive(archive, 1_000);
  assert.equal(inspection.entries, 2);
  assert.equal(inspection.noteMarkdownBytes, 8);
});

test('rejects path traversal and attachment size mismatches before any restore action', () => {
  const unsafe = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), '../escape.md': strToU8('nope') });
  assert.throws(() => inspectWorkspaceArchive(unsafe, 10_000), WorkspaceArchiveError);
  const broken = JSON.parse(JSON.stringify(manifest)) as { notes: { attachments: unknown[] }[] };
  broken.notes[0].attachments = [{ id: '550e8400-e29b-41d4-a716-446655440002', originalFileName: 'x.txt', mimeType: 'text/plain', sizeBytes: 10, path: 'attachments/hello/x.txt' }];
  const archive = zipSync({ 'manifest.json': strToU8(JSON.stringify(broken)), [manifest.notes[0].markdownPath]: strToU8('# Hello\n'), 'attachments/hello/x.txt': strToU8('short') });
  assert.throws(() => inspectWorkspaceArchive(archive, 10_000), WorkspaceArchiveError);
  const invalidVersion = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  invalidVersion.notes[0].version = 0;
  const invalidVersionArchive = zipSync({ 'manifest.json': strToU8(JSON.stringify(invalidVersion)), [manifest.notes[0].markdownPath]: strToU8('# Hello\n') });
  assert.throws(() => inspectWorkspaceArchive(invalidVersionArchive, 10_000), WorkspaceArchiveError);
});

test('rejects an individual attachment above the configured attachment limit', () => {
  const oversized = JSON.parse(JSON.stringify(manifest)) as WorkspaceBackupManifest;
  oversized.notes[0]!.attachments = [{ id: '550e8400-e29b-41d4-a716-446655440002', originalFileName: 'large.txt', mimeType: 'text/plain', sizeBytes: 3, path: 'attachments/hello/large.txt' }];
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(oversized)),
    [manifest.notes[0].markdownPath]: strToU8('# Hello\n'),
    'attachments/hello/large.txt': strToU8('big'),
  });
  assert.throws(() => inspectWorkspaceArchive(archive, 10_000, 2), WorkspaceArchiveError);
});

test('rejects duplicate ZIP filenames before interpreting the manifest', async () => {
  await assert.rejects(duplicateArchive().then((archive) => inspectWorkspaceArchive(archive, 10_000)), WorkspaceArchiveError);
});

test('rejects malformed record arrays and duplicate attachment identities across notes', () => {
  const missingArrays = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete missingArrays.notes;
  const missingArraysArchive = zipSync({
    'manifest.json': strToU8(JSON.stringify(missingArrays)),
    [manifest.notes[0].markdownPath]: strToU8('# Hello\n'),
  });
  assert.throws(() => inspectWorkspaceArchive(missingArraysArchive, 10_000), WorkspaceArchiveError);

  const duplicated = JSON.parse(JSON.stringify(manifest)) as WorkspaceBackupManifest;
  const attachment = { id: '550e8400-e29b-41d4-a716-446655440002', originalFileName: 'one.txt', mimeType: 'text/plain', sizeBytes: 3, path: 'attachments/hello/one.txt' };
  duplicated.notes[0]!.attachments = [attachment];
  duplicated.notes.push({ ...duplicated.notes[0]!, id: '550e8400-e29b-41d4-a716-446655440003', slug: 'second', markdownPath: 'notes/second-550e8400-e29b-41d4-a716-446655440003.md', attachments: [{ ...attachment, path: 'attachments/second/two.txt' }] });
  const duplicatedArchive = zipSync({
    'manifest.json': strToU8(JSON.stringify(duplicated)),
    [manifest.notes[0].markdownPath]: strToU8('# Hello\n'),
    'notes/second-550e8400-e29b-41d4-a716-446655440003.md': strToU8('# Second\n'),
    'attachments/hello/one.txt': strToU8('one'),
    'attachments/second/two.txt': strToU8('two'),
  });
  assert.throws(() => inspectWorkspaceArchive(duplicatedArchive, 10_000), WorkspaceArchiveError);
});

test('reports owner and backup identity conflicts without mutating data', () => {
  const conflicted = JSON.parse(JSON.stringify(manifest)) as WorkspaceBackupManifest;
  conflicted.notebooks = [{ id: '550e8400-e29b-41d4-a716-446655440002', name: 'Work', createdAt: manifest.exportedAt, updatedAt: manifest.exportedAt }];
  conflicted.notes.push({ ...conflicted.notes[0], id: '550e8400-e29b-41d4-a716-446655440003', slug: 'hello-2', markdownPath: 'notes/hello-2-550e8400-e29b-41d4-a716-446655440003.md' });
  assert.deepEqual(workspaceImportConflicts(conflicted, { notebookNames: ['work'], noteSlugs: ['hello-2'] }), [
    { kind: 'notebook', sourceId: '550e8400-e29b-41d4-a716-446655440002', value: 'Work', reason: 'name_exists' },
    { kind: 'note', sourceId: '550e8400-e29b-41d4-a716-446655440003', value: 'hello-2', reason: 'slug_exists' },
  ]);
});
