import type { Context } from 'hono';
import { isUUID, validateLimit } from '@qnotes/shared';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, attachmentFromRow, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { findOwnedNote } from './notes.ts';
import { validateUploadedAttachmentSize } from './attachment-size.ts';

const MIME_TYPES = new Set(['text/plain', 'text/markdown', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const defaultMaxBytes = 20 * 1024 * 1024;

function attachmentMaxBytes(): number {
  const configured = Number(Deno.env.get('QNOTES_MAX_ATTACHMENT_BYTES') ?? defaultMaxBytes);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : defaultMaxBytes;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeFileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) throw new ApiError(422, 'VALIDATION_ERROR', 'fileName must be a non-empty file name.');
  const basename = value.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  const safe = basename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 160);
  if (!safe) throw new ApiError(422, 'VALIDATION_ERROR', 'fileName must contain a safe basename.');
  return safe;
}

function statusResponse(context: Context, data: unknown, status = 200): Response {
  return context.json({ data }, status as 200);
}

export async function listAttachments(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:read');
  const note = await findOwnedNote(auth.userId, context.req.param('noteRef') ?? '');
  const { data, error } = await appDbClient.from('attachments').select('*').eq('owner_id', auth.userId).eq('note_id', note.id).is('deleted_at', null).order('created_at', { ascending: false }).limit(validateLimit(context.req.query().limit, 50, 20));
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to list attachments.');
  return statusResponse(context, (Array.isArray(data) ? data : []).map((row) => attachmentFromRow(objectRecord(row))));
}

export async function requestUpload(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:write');
  const body = objectRecord(await context.req.json());
  const noteId = body.noteId;
  if (typeof noteId !== 'string' || !isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  const note = await findOwnedNote(auth.userId, noteId);
  const fileName = safeFileName(body.fileName);
  const mimeType = body.mimeType;
  if (typeof mimeType !== 'string' || !MIME_TYPES.has(mimeType)) throw new ApiError(422, 'UNSUPPORTED_ATTACHMENT_TYPE', 'This attachment type is not supported.');
  const sizeBytes = body.sizeBytes;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new ApiError(422, 'VALIDATION_ERROR', 'sizeBytes must be a non-negative integer.');
  const maxBytes = attachmentMaxBytes();
  if (sizeBytes > maxBytes) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The attachment exceeds the configured size limit.');
  const attachmentId = crypto.randomUUID();
  const path = `${auth.userId}/${note.id}/${attachmentId}/${fileName}`;
  const inserted = await appDbClient.from('attachments').insert({ id: attachmentId, owner_id: auth.userId, note_id: note.id, bucket: 'note-attachments', object_path: path, original_file_name: fileName, mime_type: mimeType, size_bytes: sizeBytes, extraction_status: 'pending_upload' }).select('*').single();
  if (inserted.error || !inserted.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create attachment metadata.');
  const signed = await serviceClient.storage.from('note-attachments').createSignedUploadUrl(path);
  if (signed.error || !signed.data?.token) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create an attachment upload URL.');
  return statusResponse(context, { attachment: attachmentFromRow(objectRecord(inserted.data)), path, token: signed.data.token }, 201);
}

export async function finalizeAttachment(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:write');
  const attachmentId = context.req.param('attachmentId');
  if (!isUUID(attachmentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'attachmentId must be a valid UUID.');
  const row = await appDbClient.from('attachments').select('*').eq('id', attachmentId).eq('owner_id', auth.userId).is('deleted_at', null).maybeSingle();
  if (row.error || !row.data) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
  const object = await serviceClient.storage.from(row.data.bucket).download(row.data.object_path);
  if (object.error || !object.data) throw new ApiError(409, 'ATTACHMENT_NOT_UPLOADED', 'The attachment has not been uploaded.');
  const declaredSizeBytes = Number(row.data.size_bytes);
  const actualSizeBytes = object.data.size;
  const sizeCheck = validateUploadedAttachmentSize(declaredSizeBytes, actualSizeBytes, attachmentMaxBytes());
  if (!sizeCheck.ok) {
    let removeError: unknown;
    try {
      const removed = await serviceClient.storage.from(row.data.bucket).remove([row.data.object_path]);
      removeError = removed.error ?? undefined;
    } catch (error) {
      removeError = error;
    }
    const failed = await serviceClient.rpc('qnotes_fail_attachment_processing', {
      p_owner_id: auth.userId,
      p_attachment_id: attachmentId,
      p_status: 'failed',
      p_error: sizeCheck.reason === 'too_large' ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_SIZE_MISMATCH',
    });
    if (failed.error || removeError) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to safely reject the attachment.');
    if (sizeCheck.reason === 'too_large') throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The uploaded attachment exceeds the configured size limit.');
    throw new ApiError(422, 'ATTACHMENT_SIZE_MISMATCH', 'The uploaded attachment size does not match its declared size.');
  }
  const result = await serviceClient.rpc('qnotes_finalize_attachment', { p_owner_id: auth.userId, p_attachment_id: attachmentId });
  if (result.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to finalize the attachment.');
  const fresh = await appDbClient.from('attachments').select('*').eq('id', attachmentId).single();
  if (fresh.error || !fresh.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to read the finalized attachment.');
  return statusResponse(context, attachmentFromRow(objectRecord(fresh.data)));
}

export async function getDownloadUrl(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:read');
  const attachmentId = context.req.param('attachmentId');
  if (!isUUID(attachmentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'attachmentId must be a valid UUID.');
  const { data, error } = await appDbClient.from('attachments').select('*').eq('id', attachmentId).eq('owner_id', auth.userId).is('deleted_at', null).maybeSingle();
  if (error || !data) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
  const signed = await serviceClient.storage.from(data.bucket).createSignedUrl(data.object_path, 60);
  if (signed.error || !signed.data?.signedUrl) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create an attachment download URL.');
  return statusResponse(context, { signedUrl: signed.data.signedUrl, expiresInSeconds: 60 });
}

export async function deleteAttachment(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:write');
  const attachmentId = context.req.param('attachmentId');
  if (!isUUID(attachmentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'attachmentId must be a valid UUID.');
  const { data, error } = await appDbClient.from('attachments').select('bucket, object_path').eq('id', attachmentId).eq('owner_id', auth.userId).is('deleted_at', null).maybeSingle();
  if (error || !data) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
  const removed = await serviceClient.storage.from(data.bucket).remove([data.object_path]);
  if (removed.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to remove the attachment object.');
  const updated = await appDbClient.from('attachments').update({ extraction_status: 'deleted', deleted_at: new Date().toISOString() }).eq('id', attachmentId).eq('owner_id', auth.userId);
  if (updated.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to mark the attachment deleted.');
  return statusResponse(context, null);
}
