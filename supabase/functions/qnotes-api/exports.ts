import { strToU8, zipSync } from 'fflate';
import type { Context } from 'hono';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { findOwnedNote } from './notes.ts';

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 160) || 'note';
}

function binaryResponse(context: Context, body: Uint8Array, contentType: string, disposition: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType, 'content-disposition': disposition, 'x-request-id': String(context.get('requestId') ?? '') } });
}

export async function exportNote(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read');
  const note = await findOwnedNote(auth.userId, context.req.param('noteRef'));
  return binaryResponse(context, new TextEncoder().encode(note.contentMarkdown), 'text/markdown; charset=utf-8', `attachment; filename="${safeName(note.slug)}.md"`);
}

export async function exportWorkspace(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'notes:read', 'attachments:read');
  const notesResult = await appDbClient.from('notes').select('id, slug, title, tags, version, created_at, updated_at, content_markdown').eq('owner_id', auth.userId).is('deleted_at', null).order('updated_at', { ascending: true });
  if (notesResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to export notes.');
  const notes = Array.isArray(notesResult.data) ? notesResult.data as Record<string, unknown>[] : [];
  const noteIds = notes.map((note) => String(note.id));
  const attachmentsResult = noteIds.length ? await appDbClient.from('attachments').select('*').eq('owner_id', auth.userId).in('note_id', noteIds).is('deleted_at', null) : { data: [], error: null };
  if (attachmentsResult.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to export attachment metadata.');
  const attachments = Array.isArray(attachmentsResult.data) ? attachmentsResult.data as Record<string, unknown>[] : [];
  const files: Record<string, Uint8Array> = {};
  const manifestNotes = [];
  for (const note of notes) {
    const slug = safeName(String(note.slug));
    files[`notes/${slug}.md`] = strToU8(String(note.content_markdown ?? ''));
    const noteAttachments = attachments.filter((attachment) => String(attachment.note_id) === String(note.id));
    const manifestAttachments = [];
    for (const attachment of noteAttachments) {
      const original = safeName(String(attachment.original_file_name));
      const relativePath = `attachments/${slug}/${attachment.id}-${original}`;
      const downloaded = await serviceClient.storage.from(String(attachment.bucket)).download(String(attachment.object_path));
      if (downloaded.error || !downloaded.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to download an attachment for export.', { attachmentId: attachment.id });
      files[relativePath] = new Uint8Array(await downloaded.data.arrayBuffer());
      manifestAttachments.push({ id: attachment.id, originalFileName: attachment.original_file_name, mimeType: attachment.mime_type, sizeBytes: attachment.size_bytes, path: relativePath });
    }
    manifestNotes.push({ id: note.id, slug: note.slug, title: note.title, tags: note.tags, version: note.version, createdAt: note.created_at, updatedAt: note.updated_at, attachments: manifestAttachments });
  }
  files['manifest.json'] = strToU8(JSON.stringify({ exportedAt: new Date().toISOString(), notes: manifestNotes }, null, 2));
  const zip = zipSync(files);
  const maxBytes = Number(Deno.env.get('QNOTES_EXPORT_MAX_BYTES') ?? 50 * 1024 * 1024);
  if (zip.byteLength > maxBytes) throw new ApiError(413, 'EXPORT_TOO_LARGE', 'The workspace export exceeds the configured size limit.');
  return binaryResponse(context, zip, 'application/zip', 'attachment; filename="quadrate-notes-backup.zip"');
}
