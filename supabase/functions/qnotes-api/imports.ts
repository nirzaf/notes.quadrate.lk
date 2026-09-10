import type { Context } from 'hono';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { enforceRequestBudget } from '../_shared/request-limits.ts';
import { workspaceMaxBytes } from './exports.ts';
import { createNoteMutation } from './notes.ts';
import { requireAccountWide } from '../_shared/notebook-access.ts';
import {
  inspectWorkspaceArchive,
  safeImportFileName,
  validateWorkspaceContents,
  WorkspaceArchiveError,
  workspaceImportConflicts,
  workspaceImportUuid,
  type WorkspaceArchiveInspection,
  type WorkspaceBackupManifest,
  type WorkspaceImportConflict,
} from './workspace-import.ts';

const defaultMaxAttachmentBytes = 20 * 1024 * 1024;
const attachmentBucket = 'note-attachments';

function attachmentMaxBytes(): number {
  const configured = Number(Deno.env.get('QNOTES_MAX_ATTACHMENT_BYTES') ?? defaultMaxAttachmentBytes);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : defaultMaxAttachmentBytes;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function conflictError(conflicts: WorkspaceImportConflict[]): ApiError {
  return new ApiError(409, 'VALIDATION_ERROR', 'The workspace restore conflicts with existing workspace data and was not started.', { conflicts });
}

function archiveText(inspection: WorkspaceArchiveInspection, path: string): string {
  const file = inspection.files[path];
  if (!file) throw new ApiError(422, 'VALIDATION_ERROR', 'The backup is missing a required Markdown file.');
  try {
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(file);
    return markdown;
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The backup contains invalid UTF-8 Markdown.');
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function workspaceConflicts(ownerId: string, manifest: WorkspaceBackupManifest): Promise<WorkspaceImportConflict[]> {
  const [notesResult, notebooksResult] = await Promise.all([
    appDbClient.from('notes').select('id, slug, title, deleted_at, last_mutation_id').eq('owner_id', ownerId),
    appDbClient.from('notebooks').select('id, name').eq('owner_id', ownerId),
  ]);
  if (notesResult.error || notebooksResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to inspect workspace conflicts.');

  const notes = Array.isArray(notesResult.data) ? notesResult.data as Record<string, unknown>[] : [];
  const notebooks = Array.isArray(notebooksResult.data) ? notebooksResult.data as Record<string, unknown>[] : [];
  const [expectedNoteIds, expectedNotebookIds, expectedNoteMutationIds] = await Promise.all([
    Promise.all(manifest.notes.map((note) => workspaceImportUuid(ownerId, manifest.backupId, 'note', note.id))),
    Promise.all(manifest.notebooks.map((notebook) => workspaceImportUuid(ownerId, manifest.backupId, 'notebook', notebook.id))),
    Promise.all(manifest.notes.map((note) => workspaceImportUuid(ownerId, manifest.backupId, 'note', `${note.id}:mutation`))),
  ]);
  const expectedNotes = new Map(expectedNoteIds.map((id, index) => [id, { note: manifest.notes[index], mutationId: expectedNoteMutationIds[index] }]));
  const expectedNotebooks = new Map(expectedNotebookIds.map((id, index) => [id, manifest.notebooks[index]]));
  const conflicts: WorkspaceImportConflict[] = [];

  for (const row of notes) {
    const expected = expectedNotes.get(String(row.id ?? ''));
    if (expected && (row.deleted_at || lower(String(row.slug ?? '')) !== lower(expected.note?.slug ?? '') || String(row.title ?? '') !== expected.note?.title || String(row.last_mutation_id ?? '') !== expected.mutationId)) {
      conflicts.push({ kind: 'note', sourceId: expected.note?.id ?? '', value: expected.note?.slug ?? '', reason: 'import_identity_conflict' });
    }
  }
  for (const row of notebooks) {
    const expected = expectedNotebooks.get(String(row.id ?? ''));
    if (expected && lower(String(row.name ?? '')) !== lower(expected.name)) {
      conflicts.push({ kind: 'notebook', sourceId: expected.id, value: expected.name, reason: 'import_identity_conflict' });
    }
  }

  const attachmentsResult = await appDbClient.from('attachments').select('id, note_id, bucket, object_path, original_file_name, mime_type, size_bytes, deleted_at').eq('owner_id', ownerId);
  if (attachmentsResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to inspect imported attachment conflicts.');
  const attachments = Array.isArray(attachmentsResult.data) ? attachmentsResult.data as Record<string, unknown>[] : [];
  const attachmentsById = new Map(attachments.map((row) => [String(row.id ?? ''), row]));
  const attachmentsByPath = new Map(attachments.map((row) => [String(row.object_path ?? ''), row]));
  const noteTargetIds = new Map(manifest.notes.map((note, index) => [note.id, expectedNoteIds[index] as string]));
  for (const sourceNote of manifest.notes) {
    const targetNoteId = noteTargetIds.get(sourceNote.id);
    if (!targetNoteId) continue;
    for (const sourceAttachment of sourceNote.attachments) {
      const targetId = await workspaceImportUuid(ownerId, manifest.backupId, 'attachment', sourceAttachment.id);
      const fileName = safeImportFileName(sourceAttachment.originalFileName);
      const objectPath = importedAttachmentPath(ownerId, manifest.backupId, targetNoteId, targetId, fileName);
      const existingById = attachmentsById.get(targetId);
      const existingByPath = attachmentsByPath.get(objectPath);
      const existing = existingById ?? existingByPath;
      if (!existing) continue;
      if (existing.deleted_at || String(existing.id ?? '') !== targetId || String(existing.note_id ?? '') !== targetNoteId || String(existing.bucket ?? '') !== attachmentBucket || String(existing.object_path ?? '') !== objectPath || String(existing.original_file_name ?? '') !== fileName || String(existing.mime_type ?? '') !== sourceAttachment.mimeType || Number(existing.size_bytes) !== sourceAttachment.sizeBytes) {
        conflicts.push({ kind: 'attachment', sourceId: sourceAttachment.id, value: fileName, reason: 'import_identity_conflict' });
      }
    }
  }

  conflicts.push(...workspaceImportConflicts(manifest, {
    notebookNames: notebooks.filter((row) => !expectedNotebooks.has(String(row.id ?? ''))).map((row) => String(row.name ?? '')),
    noteSlugs: notes.filter((row) => !row.deleted_at && !expectedNotes.has(String(row.id ?? ''))).map((row) => String(row.slug ?? '')),
  }));
  return conflicts;
}

async function ensureNotebook(ownerId: string, backupId: string, notebook: WorkspaceBackupManifest['notebooks'][number]): Promise<string> {
  const targetId = await workspaceImportUuid(ownerId, backupId, 'notebook', notebook.id);
  const existing = await appDbClient.from('notebooks').select('id, name').eq('id', targetId).eq('owner_id', ownerId).maybeSingle();
  if (existing.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to inspect an imported notebook.');
  if (existing.data) {
    if (lower(existing.data.name) !== lower(notebook.name)) throw conflictError([{ kind: 'notebook', sourceId: notebook.id, value: notebook.name, reason: 'import_identity_conflict' }]);
    return targetId;
  }

  const inserted = await appDbClient.from('notebooks').insert({ id: targetId, owner_id: ownerId, name: notebook.name }).select('id, name').single();
  if (inserted.error || !inserted.data) {
    if (inserted.error?.code === '23505') {
      const raced = await appDbClient.from('notebooks').select('id, name').eq('id', targetId).eq('owner_id', ownerId).maybeSingle();
      if (!raced.error && raced.data && lower(raced.data.name) === lower(notebook.name)) return targetId;
      throw conflictError([{ kind: 'notebook', sourceId: notebook.id, value: notebook.name, reason: 'name_exists' }]);
    }
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to restore a notebook.');
  }
  return targetId;
}

function importedAttachmentPath(ownerId: string, backupId: string, noteId: string, attachmentId: string, fileName: string): string {
  return `${ownerId}/${noteId}/imports/${backupId}/${attachmentId}/${fileName}`;
}

async function failImportedAttachment(ownerId: string, attachmentId: string, objectPath: string): Promise<void> {
  const removed = await serviceClient.storage.from(attachmentBucket).remove([objectPath]);
  const failed = await serviceClient.rpc('qnotes_fail_attachment_processing', {
    p_owner_id: ownerId,
    p_attachment_id: attachmentId,
    p_status: 'failed',
    p_error: 'ATTACHMENT_SIZE_MISMATCH',
  });
  if (removed.error || failed.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to safely reject an imported attachment.');
}

async function ensureImportedAttachment(
  ownerId: string,
  backupId: string,
  noteId: string,
  sourceAttachment: WorkspaceBackupManifest['notes'][number]['attachments'][number],
  inspection: WorkspaceArchiveInspection,
): Promise<void> {
  const bytes = inspection.files[sourceAttachment.path];
  if (!bytes) throw new ApiError(422, 'VALIDATION_ERROR', 'The backup is missing an attachment file.');
  const fileName = safeImportFileName(sourceAttachment.originalFileName);
  const targetId = await workspaceImportUuid(ownerId, backupId, 'attachment', sourceAttachment.id);
  const objectPath = importedAttachmentPath(ownerId, backupId, noteId, targetId, fileName);
  const existing = await appDbClient.from('attachments').select('*').eq('id', targetId).eq('owner_id', ownerId).maybeSingle();
  if (existing.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to inspect an imported attachment.');
  if (existing.data) {
    if (existing.data.deleted_at || String(existing.data.note_id) !== noteId || String(existing.data.bucket) !== attachmentBucket || String(existing.data.object_path) !== objectPath || String(existing.data.original_file_name) !== fileName || String(existing.data.mime_type) !== sourceAttachment.mimeType || Number(existing.data.size_bytes) !== sourceAttachment.sizeBytes) {
      throw conflictError([{ kind: 'note', sourceId: noteId, value: fileName, reason: 'import_identity_conflict' }]);
    }
  } else {
    let uploadedHere = false;
    const uploaded = await serviceClient.storage.from(attachmentBucket).upload(objectPath, bytes, { contentType: sourceAttachment.mimeType, upsert: false });
    if (uploaded.error) {
      const existingObject = await serviceClient.storage.from(attachmentBucket).download(objectPath);
      if (existingObject.error || !existingObject.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to upload an imported attachment.');
      const existingBytes = new Uint8Array(await existingObject.data.arrayBuffer());
      if (!bytesEqual(existingBytes, bytes)) throw conflictError([{ kind: 'note', sourceId: noteId, value: fileName, reason: 'import_identity_conflict' }]);
    } else {
      uploadedHere = true;
    }

    const inserted = await appDbClient.from('attachments').insert({
      id: targetId,
      owner_id: ownerId,
      note_id: noteId,
      bucket: attachmentBucket,
      object_path: objectPath,
      original_file_name: fileName,
      mime_type: sourceAttachment.mimeType,
      size_bytes: sourceAttachment.sizeBytes,
      extraction_status: 'pending_upload',
    }).select('*').single();
    if (inserted.error || !inserted.data) {
      if (inserted.error?.code === '23505') {
        const raced = await appDbClient.from('attachments').select('*').eq('id', targetId).eq('owner_id', ownerId).maybeSingle();
        if (!raced.error && raced.data && !raced.data.deleted_at && String(raced.data.note_id) === noteId && String(raced.data.object_path) === objectPath && Number(raced.data.size_bytes) === sourceAttachment.sizeBytes) {
          // Another retry created the same logical item. Continue with the
          // same object verification and finalization below.
        } else {
          if (uploadedHere) await serviceClient.storage.from(attachmentBucket).remove([objectPath]);
          throw conflictError([{ kind: 'note', sourceId: noteId, value: fileName, reason: 'import_identity_conflict' }]);
        }
      } else {
        if (uploadedHere) await serviceClient.storage.from(attachmentBucket).remove([objectPath]);
        throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create imported attachment metadata.');
      }
    }
  }

  const downloaded = await serviceClient.storage.from(attachmentBucket).download(objectPath);
  if (downloaded.error || !downloaded.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to verify an imported attachment.');
  const actualBytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (actualBytes.byteLength !== sourceAttachment.sizeBytes || !bytesEqual(actualBytes, bytes)) {
    await failImportedAttachment(ownerId, targetId, objectPath);
    throw new ApiError(422, 'ATTACHMENT_SIZE_MISMATCH', 'The imported attachment bytes do not match its manifest.');
  }

  const finalized = await serviceClient.rpc('qnotes_finalize_attachment', { p_owner_id: ownerId, p_attachment_id: targetId });
  if (finalized.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to queue an imported attachment for processing.');
  const status = record(finalized.data).status;
  if (status === 'not_found') throw new ApiError(500, 'INTERNAL_ERROR', 'The imported attachment metadata disappeared during restore.');
}

interface RestoreSummary {
  notebooks: number;
  notes: number;
  attachments: number;
}

async function restoreWorkspace(ownerId: string, inspection: WorkspaceArchiveInspection): Promise<RestoreSummary> {
  const { manifest } = inspection;
  const notebookIds = new Map<string, string>();
  for (const notebook of manifest.notebooks) notebookIds.set(notebook.id, await ensureNotebook(ownerId, manifest.backupId, notebook));

  let notes = 0;
  let attachments = 0;
  for (const sourceNote of manifest.notes) {
    const targetNoteId = await workspaceImportUuid(ownerId, manifest.backupId, 'note', sourceNote.id);
    const deviceId = await workspaceImportUuid(ownerId, manifest.backupId, 'note', `${sourceNote.id}:device`);
    const mutationId = await workspaceImportUuid(ownerId, manifest.backupId, 'note', `${sourceNote.id}:mutation`);
    const notebookId = sourceNote.notebookId ? notebookIds.get(sourceNote.notebookId) ?? null : null;
    const result = await createNoteMutation(ownerId, {
      title: sourceNote.title,
      slug: sourceNote.slug,
      contentMarkdown: archiveText(inspection, sourceNote.markdownPath),
      tags: sourceNote.tags,
      notebookId,
      deviceId,
      mutationId,
    }, targetNoteId);
    if (result.note.id !== targetNoteId) throw new ApiError(409, 'VALIDATION_ERROR', 'The backup import identity does not match the restored note.');
    notes += 1;
    for (const attachment of sourceNote.attachments) {
      await ensureImportedAttachment(ownerId, manifest.backupId, targetNoteId, attachment, inspection);
      attachments += 1;
    }
  }
  return { notebooks: manifest.notebooks.length, notes, attachments };
}

function summary(inspection: WorkspaceArchiveInspection, archiveBytes: number, conflicts: WorkspaceImportConflict[], dryRun: boolean, restored?: RestoreSummary) {
  const { manifest } = inspection;
  return {
    dryRun,
    ready: conflicts.length === 0,
    message: dryRun ? 'Backup archive is valid and unchanged; no workspace data was written.' : 'Workspace backup restored without overwriting existing data.',
    format: manifest.format,
    formatVersion: inspection.sourceFormatVersion,
    backupId: manifest.backupId,
    compressedBytes: archiveBytes,
    declaredUncompressedBytes: inspection.uncompressedBytes,
    entries: inspection.entries,
    uncompressedBytes: inspection.uncompressedBytes,
    noteMarkdownBytes: inspection.noteMarkdownBytes,
    attachmentBytes: inspection.attachmentBytes,
    conflicts,
    unsupportedFiles: [],
    validationFailures: [],
    notebooks: restored?.notebooks ?? manifest.notebooks.length,
    notes: restored?.notes ?? manifest.notes.length,
    attachments: restored?.attachments ?? manifest.notes.reduce((count, note) => count + note.attachments.length, 0),
  };
}

export async function inspectWorkspaceImport(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read', 'notes:write', 'attachments:read', 'attachments:write');
  requireAccountWide(auth, 'Workspace import requires an account-wide token access grant.');
  const confirmed = context.req.query('confirm') === 'true';
  if (context.req.query('dryRun') === 'false' && !confirmed) throw new ApiError(409, 'VALIDATION_ERROR', 'Workspace restore requires explicit confirm=true after a successful dry run.');
  await enforceRequestBudget('workspace-import', `user:${auth.userId}`, confirmed ? 2 : 1);
  context.set('limitDecision', confirmed ? 'workspace-import-confirmed' : 'workspace-import-dry-run');
  const archive = new Uint8Array(await context.req.arrayBuffer());
  try {
    const inspection = await inspectWorkspaceArchive(archive, workspaceMaxBytes(), attachmentMaxBytes());
    await validateWorkspaceContents(inspection);
    const conflicts = await workspaceConflicts(auth.userId, inspection.manifest);
    if (!confirmed) {
      context.header('Cache-Control', 'no-store');
      return context.json({ data: summary(inspection, archive.byteLength, conflicts, true) });
    }
    if (conflicts.length) throw conflictError(conflicts);
    const restored = await restoreWorkspace(auth.userId, inspection);
    context.header('Cache-Control', 'no-store');
    return context.json({ data: summary(inspection, archive.byteLength, [], false, restored) });
  } catch (error) {
    if (error instanceof WorkspaceArchiveError) throw new ApiError(422, 'VALIDATION_ERROR', error.message, { validationFailures: [error.message] });
    throw error;
  }
}
