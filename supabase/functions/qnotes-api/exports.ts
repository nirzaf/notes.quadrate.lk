import { strToU8, zipSync } from 'fflate';
import type { Context } from 'hono';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { enforceRequestBudget } from '../_shared/request-limits.ts';
import { findAuthorizedNote } from './notes.ts';
import { applyNotebookAccess, applyNotebookIdAccess } from '../_shared/notebook-access.ts';
import { planWorkspaceExport } from './export-preflight.ts';

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 160) || 'note';
}

function binaryResponse(context: Context, body: Uint8Array, contentType: string, disposition: string): Response {
  return new Response(body as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType, 'content-disposition': disposition, 'x-request-id': String(context.get('requestId') ?? '') } });
}

export function workspaceMaxBytes(): number {
  const configured = Number(Deno.env.get('QNOTES_EXPORT_MAX_BYTES') ?? 50 * 1024 * 1024);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 50 * 1024 * 1024;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function exportNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findAuthorizedNote(auth, context.req.param('noteRef') ?? '');
  return binaryResponse(context, new TextEncoder().encode(note.contentMarkdown), 'text/markdown; charset=utf-8', `attachment; filename="${safeName(note.slug)}.md"`);
}

export async function exportWorkspace(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read', 'attachments:read');
  await enforceRequestBudget('workspace-export', `user:${auth.userId}`);
  context.set('limitDecision', 'workspace-export-allowed');
  let notesQuery = appDbClient.from('notes').select('id, slug, title, tags, notebook_id, version, created_at, updated_at, content_markdown').eq('owner_id', auth.userId).is('deleted_at', null);
  notesQuery = applyNotebookAccess(notesQuery, auth);
  let notebooksQuery = appDbClient.from('notebooks').select('id, name, created_at, updated_at').eq('owner_id', auth.userId);
  notebooksQuery = applyNotebookIdAccess(notebooksQuery, auth);
  const [notesResult, notebooksResult] = await Promise.all([
    notesQuery.order('updated_at', { ascending: true }),
    notebooksQuery.order('created_at', { ascending: true }).order('name', { ascending: true }),
  ]);
  if (notesResult.error || notebooksResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to export the workspace.');
  const notes = Array.isArray(notesResult.data) ? notesResult.data as Record<string, unknown>[] : [];
  const notebooks = Array.isArray(notebooksResult.data) ? notebooksResult.data as Record<string, unknown>[] : [];
  const noteIds = notes.map((note) => String(note.id));
  const attachmentsResult = noteIds.length ? await appDbClient.from('attachments').select('*').eq('owner_id', auth.userId).in('note_id', noteIds).in('extraction_status', ['uploaded', 'queued', 'processing', 'ready', 'failed', 'unsupported']).is('deleted_at', null) : { data: [], error: null };
  if (attachmentsResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to export attachment metadata.');
  const attachments = (Array.isArray(attachmentsResult.data) ? attachmentsResult.data as Record<string, unknown>[] : []).filter((attachment) => String(attachment.extraction_status) !== 'failed' || (String(attachment.object_path ?? '') !== '' && attachment.verified_at != null));
  const files: Record<string, Uint8Array> = {};
  const attachmentsByNote = new Map<string, Record<string, unknown>[]>();
  for (const attachment of attachments) {
    const noteId = String(attachment.note_id);
    const list = attachmentsByNote.get(noteId) ?? [];
    list.push(attachment);
    attachmentsByNote.set(noteId, list);
  }
  const manifestNotes = [];
  let noteMarkdownBytes = 0;
  let attachmentBytes = 0;
  for (const note of notes) {
    const slug = safeName(String(note.slug));
    const markdownPath = `notes/${slug}-${String(note.id)}.md`;
    const markdown = strToU8(String(note.content_markdown ?? ''));
    noteMarkdownBytes += markdown.byteLength;
    files[markdownPath] = markdown;
    const noteAttachments = attachmentsByNote.get(String(note.id)) ?? [];
    const manifestAttachments = [];
    for (const attachment of noteAttachments) {
      const original = safeName(String(attachment.original_file_name));
      const relativePath = `attachments/${slug}/${attachment.id}-${original}`;
      const sizeBytes = Number(attachment.size_bytes);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new ApiError(500, 'INTERNAL_ERROR', 'Attachment metadata is invalid for export.');
      attachmentBytes += sizeBytes;
      manifestAttachments.push({ id: attachment.id, originalFileName: attachment.original_file_name, mimeType: attachment.mime_type, sizeBytes: attachment.size_bytes, path: relativePath });
    }
    manifestNotes.push({ id: note.id, slug: note.slug, title: note.title, tags: note.tags, notebookId: note.notebook_id ?? null, version: note.version, createdAt: note.created_at, updatedAt: note.updated_at, markdownPath, attachments: manifestAttachments });
  }
  const manifest = {
    format: 'quadrate-notes-workspace',
    formatVersion: 2,
    backupId: crypto.randomUUID(),
    exportedAt: new Date().toISOString(),
    notebooks: notebooks.map((notebook) => ({ id: notebook.id, name: notebook.name, createdAt: notebook.created_at, updatedAt: notebook.updated_at })),
    notes: manifestNotes,
  };
  const manifestBytes = strToU8(JSON.stringify(manifest, null, 2));
  const plan = planWorkspaceExport(noteMarkdownBytes, attachmentBytes, manifestBytes.byteLength, notes.length + attachments.length + 1, workspaceMaxBytes());
  if (!plan.ok) {
    if (plan.reason === 'invalid_metadata') throw new ApiError(500, 'INTERNAL_ERROR', 'Workspace export metadata is invalid.');
    throw new ApiError(413, 'EXPORT_TOO_LARGE', plan.reason === 'too_many_entries' ? 'The workspace export contains too many files.' : 'The workspace export exceeds the configured size limit.');
  }
  let downloadedAttachmentBytes = 0;
  for (const attachment of attachments) {
    const slug = safeName(String(notes.find((note) => String(note.id) === String(attachment.note_id))?.slug ?? 'note'));
    const relativePath = `attachments/${slug}/${attachment.id}-${safeName(String(attachment.original_file_name))}`;
    const downloaded = await serviceClient.storage.from(String(attachment.bucket)).download(String(attachment.object_path));
    if (downloaded.error || !downloaded.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to download an attachment for export.');
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    if (bytes.byteLength !== Number(attachment.size_bytes)) throw new ApiError(500, 'INTERNAL_ERROR', 'Attachment bytes do not match export metadata.');
    if (attachment.storage_mode === 'immutable' && (String(attachment.checksum_sha256 ?? '') !== await sha256Bytes(bytes) || !attachment.verified_at)) throw new ApiError(500, 'INTERNAL_ERROR', 'Attachment bytes failed the verified digest check.');
    downloadedAttachmentBytes += bytes.byteLength;
    const actualPlan = planWorkspaceExport(noteMarkdownBytes, downloadedAttachmentBytes, manifestBytes.byteLength, notes.length + attachments.length + 1, workspaceMaxBytes());
    if (!actualPlan.ok) throw new ApiError(413, 'EXPORT_TOO_LARGE', 'The workspace export exceeds the configured size limit.');
    files[relativePath] = bytes;
  }
  files['manifest.json'] = manifestBytes;
  const zip = zipSync(files);
  const maxBytes = workspaceMaxBytes();
  if (zip.byteLength > maxBytes) throw new ApiError(413, 'EXPORT_TOO_LARGE', 'The workspace export exceeds the configured size limit.');
  return binaryResponse(context, zip, 'application/zip', 'attachment; filename="qnotes-backup.zip"');
}
