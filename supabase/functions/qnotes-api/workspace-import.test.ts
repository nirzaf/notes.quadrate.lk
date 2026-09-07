import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';
import { inspectWorkspaceArchive, safeImportFileName, validateWorkspaceContents, WorkspaceArchiveError, workspaceImportConflicts, workspaceImportUuid, type WorkspaceBackupManifest } from './workspace-import.ts';

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

test('validates a version-two workspace archive and its byte manifest', async () => {
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    [manifest.notes[0].markdownPath]: strToU8('# Hello\n'),
  });
  const inspection = await inspectWorkspaceArchive(archive, 1_000);
  assert.equal(inspection.sourceFormatVersion, 2);
  assert.equal(inspection.entries, 2);
  assert.equal(inspection.noteMarkdownBytes, 8);
  assert.equal(new TextDecoder().decode(inspection.files[manifest.notes[0].markdownPath]), '# Hello\n');
});

test('derives stable owner-scoped identities for retryable imports', async () => {
  const owner = '550e8400-e29b-41d4-a716-446655440010';
  const notebook = await workspaceImportUuid(owner, manifest.backupId, 'notebook', '550e8400-e29b-41d4-a716-446655440011');
  const notebookRetry = await workspaceImportUuid(owner, manifest.backupId, 'notebook', '550e8400-e29b-41d4-a716-446655440011');
  const note = await workspaceImportUuid(owner, manifest.backupId, 'note', '550e8400-e29b-41d4-a716-446655440011');
  const otherOwner = await workspaceImportUuid('550e8400-e29b-41d4-a716-446655440012', manifest.backupId, 'notebook', '550e8400-e29b-41d4-a716-446655440011');
  assert.match(notebook, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(notebook, notebookRetry);
  assert.notEqual(notebook, note);
  assert.notEqual(notebook, otherOwner);
  assert.equal(safeImportFileName('../screenshots/test image.png'), 'test_image.png');
  assert.throws(() => safeImportFileName('..'), WorkspaceArchiveError);
});

test('validates Markdown syntax before a restore can be marked ready', async () => {
  const invalidArchive = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    [manifest.notes[0].markdownPath]: strToU8(':::copy {id="broken"}\nmissing closing marker'),
  });
  const inspection = await inspectWorkspaceArchive(invalidArchive, 10_000);
  await assert.rejects(validateWorkspaceContents(inspection), /not closed/);
});

test('accepts the legacy workspace archive format with a stable normalized identity', async () => {
  const attachmentId = '550e8400-e29b-41d4-a716-446655440002';
  const legacy = {
    exportedAt: '2026-09-06T00:00:00.000Z',
    notes: [{ id: manifest.notes[0].id, slug: 'hello', title: 'Hello', tags: ['demo'], version: 3, createdAt: manifest.exportedAt, updatedAt: manifest.exportedAt, attachments: [{ id: attachmentId, originalFileName: 'hello.txt', mimeType: 'text/plain', sizeBytes: 5, path: `attachments/hello/${attachmentId}-hello.txt` }] }],
  };
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(legacy)),
    'notes/hello.md': strToU8('# Hello\n'),
    [`attachments/hello/${attachmentId}-hello.txt`]: strToU8('hello'),
  });
  const inspection = await inspectWorkspaceArchive(archive, 10_000);
  const retry = await inspectWorkspaceArchive(archive, 10_000);
  assert.equal(inspection.sourceFormatVersion, 1);
  assert.equal(inspection.manifest.formatVersion, 2);
  assert.equal(inspection.manifest.notes[0]?.notebookId, null);
  assert.equal(inspection.manifest.notes[0]?.markdownPath, 'notes/hello.md');
  assert.equal(inspection.manifest.backupId, retry.manifest.backupId);
  assert.equal(inspection.attachmentBytes, 5);
});

test('rejects path traversal and attachment size mismatches before any restore action', async () => {
  const unsafe = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), '../escape.md': strToU8('nope') });
  await assert.rejects(inspectWorkspaceArchive(unsafe, 10_000), WorkspaceArchiveError);
  const broken = JSON.parse(JSON.stringify(manifest)) as { notes: { attachments: unknown[] }[] };
  broken.notes[0].attachments = [{ id: '550e8400-e29b-41d4-a716-446655440002', originalFileName: 'x.txt', mimeType: 'text/plain', sizeBytes: 10, path: 'attachments/hello/x.txt' }];
  const archive = zipSync({ 'manifest.json': strToU8(JSON.stringify(broken)), [manifest.notes[0].markdownPath]: strToU8('# Hello\n'), 'attachments/hello/x.txt': strToU8('short') });
  await assert.rejects(inspectWorkspaceArchive(archive, 10_000), WorkspaceArchiveError);
  const invalidVersion = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  invalidVersion.notes[0].version = 0;
  const invalidVersionArchive = zipSync({ 'manifest.json': strToU8(JSON.stringify(invalidVersion)), [manifest.notes[0].markdownPath]: strToU8('# Hello\n') });
  await assert.rejects(inspectWorkspaceArchive(invalidVersionArchive, 10_000), WorkspaceArchiveError);
});

test('rejects an individual attachment above the configured attachment limit', async () => {
  const oversized = JSON.parse(JSON.stringify(manifest)) as WorkspaceBackupManifest;
  oversized.notes[0]!.attachments = [{ id: '550e8400-e29b-41d4-a716-446655440002', originalFileName: 'large.txt', mimeType: 'text/plain', sizeBytes: 3, path: 'attachments/hello/large.txt' }];
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(oversized)),
    [manifest.notes[0].markdownPath]: strToU8('# Hello\n'),
    'attachments/hello/large.txt': strToU8('big'),
  });
  await assert.rejects(inspectWorkspaceArchive(archive, 10_000, 2), WorkspaceArchiveError);
});

test('rejects an archive that exceeds the configured compressed-byte limit', async () => {
  await assert.rejects(inspectWorkspaceArchive(new Uint8Array(11), 10), WorkspaceArchiveError);
});

test('rejects duplicate ZIP filenames before interpreting the manifest', async () => {
  await assert.rejects(duplicateArchive().then((archive) => inspectWorkspaceArchive(archive, 10_000)), WorkspaceArchiveError);
});

test('rejects malformed record arrays and duplicate attachment identities across notes', async () => {
  const missingArrays = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete missingArrays.notes;
  const missingArraysArchive = zipSync({
    'manifest.json': strToU8(JSON.stringify(missingArrays)),
    [manifest.notes[0].markdownPath]: strToU8('# Hello\n'),
  });
  await assert.rejects(inspectWorkspaceArchive(missingArraysArchive, 10_000), WorkspaceArchiveError);

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
  await assert.rejects(inspectWorkspaceArchive(duplicatedArchive, 10_000), WorkspaceArchiveError);
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
