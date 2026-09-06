import type { Context } from 'hono';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { workspaceMaxBytes } from './exports.ts';
import { inspectWorkspaceArchive, WorkspaceArchiveError, workspaceImportConflicts } from './workspace-import.ts';

const defaultMaxAttachmentBytes = 20 * 1024 * 1024;

function attachmentMaxBytes(): number {
  const configured = Number(Deno.env.get('QNOTES_MAX_ATTACHMENT_BYTES') ?? defaultMaxAttachmentBytes);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : defaultMaxAttachmentBytes;
}

export async function inspectWorkspaceImport(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read', 'notes:write', 'attachments:read', 'attachments:write');
  if (context.req.query('confirm') === 'true' || context.req.query('dryRun') === 'false') throw new ApiError(409, 'VALIDATION_ERROR', 'Workspace restore is intentionally disabled until note and Storage writes can be committed atomically.');
  const archive = new Uint8Array(await context.req.arrayBuffer());
  try {
    const inspection = inspectWorkspaceArchive(archive, workspaceMaxBytes(), attachmentMaxBytes());
    const manifest = inspection.manifest;
    const [notesResult, notebooksResult] = await Promise.all([
      appDbClient.from('notes').select('slug').eq('owner_id', auth.userId).is('deleted_at', null),
      appDbClient.from('notebooks').select('name').eq('owner_id', auth.userId),
    ]);
    if (notesResult.error || notebooksResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to inspect workspace conflicts.');
    const conflicts = workspaceImportConflicts(manifest, {
      noteSlugs: (Array.isArray(notesResult.data) ? notesResult.data : []).map((row) => String((row as Record<string, unknown>).slug ?? '')),
      notebookNames: (Array.isArray(notebooksResult.data) ? notebooksResult.data : []).map((row) => String((row as Record<string, unknown>).name ?? '')),
    });
    context.header('Cache-Control', 'no-store');
    return context.json({ data: {
      dryRun: true,
      ready: false,
      message: 'Backup archive is valid and unchanged; no workspace data was written.',
      format: manifest.format,
      formatVersion: manifest.formatVersion,
      backupId: manifest.backupId,
      compressedBytes: archive.byteLength,
      declaredUncompressedBytes: inspection.uncompressedBytes,
      entries: inspection.entries,
      uncompressedBytes: inspection.uncompressedBytes,
      noteMarkdownBytes: inspection.noteMarkdownBytes,
      attachmentBytes: inspection.attachmentBytes,
      conflicts,
      unsupportedFiles: [],
      validationFailures: [],
      notebooks: manifest.notebooks.length,
      notes: manifest.notes.length,
      attachments: manifest.notes.reduce((count, note) => count + note.attachments.length, 0),
    } });
  } catch (error) {
    if (error instanceof WorkspaceArchiveError) throw new ApiError(422, 'VALIDATION_ERROR', error.message, { validationFailures: [error.message] });
    throw error;
  }
}
