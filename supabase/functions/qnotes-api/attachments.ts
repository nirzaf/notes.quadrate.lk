import type { Context } from 'hono';
import { isUUID, validateLimit } from '@qnotes/shared';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, attachmentFromRow, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { ensureFinalObject, removeAttachmentObjectsOrScheduleDeletion, sha256Bytes, uniquePaths } from '../_shared/attachment-storage.ts';
import { enforceRequestBudget } from '../_shared/request-limits.ts';
import { findAuthorizedNote } from './notes.ts';
import { validateUploadedAttachmentSize } from './attachment-size.ts';
import { validateAttachmentSignature } from './attachment-signature.ts';

const MIME_TYPES = new Set(['text/plain', 'text/markdown', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const defaultMaxBytes = 20 * 1024 * 1024;
const uploadRetentionMs = 60 * 60 * 1000;

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

function browserStorageUrl(value: string): string {
  const configured = Deno.env.get('QNOTES_PUBLIC_SUPABASE_URL')?.trim();
  if (!configured) return value;
  let publicUrl: URL;
  let signedUrl: URL;
  try {
    publicUrl = new URL(configured);
    signedUrl = new URL(value);
  } catch {
    throw new ApiError(503, 'INTERNAL_ERROR', 'The public Supabase URL is invalid.');
  }
  if ((publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new ApiError(503, 'INTERNAL_ERROR', 'The public Supabase URL is invalid.');
  }
  signedUrl.protocol = publicUrl.protocol;
  signedUrl.host = publicUrl.host;
  return signedUrl.toString();
}

async function failVerification(ownerId: string, attachmentId: string, error: string, status = 'failed'): Promise<void> {
  const failed = await serviceClient.rpc('qnotes_fail_attachment_processing', {
    p_owner_id: ownerId,
    p_attachment_id: attachmentId,
    p_status: status,
    p_error: error,
  });
  if (failed.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to record the attachment verification failure.');
}

export async function listAttachments(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:read');
  const note = await findAuthorizedNote(auth, context.req.param('noteRef') ?? '');
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
  const note = await findAuthorizedNote(auth, noteId);
  const fileName = safeFileName(body.fileName);
  const mimeType = body.mimeType;
  if (typeof mimeType !== 'string' || !MIME_TYPES.has(mimeType)) throw new ApiError(422, 'UNSUPPORTED_ATTACHMENT_TYPE', 'This attachment type is not supported.');
  const sizeBytes = body.sizeBytes;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new ApiError(422, 'VALIDATION_ERROR', 'sizeBytes must be a non-negative integer.');
  const maxBytes = attachmentMaxBytes();
  if (sizeBytes > maxBytes) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The attachment exceeds the configured size limit.');
  const attachmentId = crypto.randomUUID();
  const stagingPath = `${auth.userId}/${note.id}/staging/${attachmentId}/${fileName}`;
  const finalPath = `${auth.userId}/${note.id}/final/${attachmentId}/${fileName}`;
  const inserted = await appDbClient.from('attachments').insert({ id: attachmentId, owner_id: auth.userId, note_id: note.id, bucket: 'note-attachments', object_path: finalPath, staging_object_path: stagingPath, original_file_name: fileName, mime_type: mimeType, size_bytes: sizeBytes, storage_mode: 'immutable', staging_expires_at: new Date(Date.now() + uploadRetentionMs).toISOString(), extraction_status: 'pending_upload' }).select('*').single();
  if (inserted.error || !inserted.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create attachment metadata.');
  const signed = await serviceClient.storage.from('note-attachments').createSignedUploadUrl(stagingPath);
  if (signed.error || !signed.data?.token) {
    await failVerification(auth.userId, attachmentId, 'UPLOAD_URL_FAILED');
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create an attachment upload URL.');
  }
  return statusResponse(context, { attachment: attachmentFromRow(objectRecord(inserted.data)), path: stagingPath, token: signed.data.token }, 201);
}

export async function finalizeAttachment(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:write');
  const attachmentId = context.req.param('attachmentId');
  if (!isUUID(attachmentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'attachmentId must be a valid UUID.');
  const row = await appDbClient.from('attachments').select('*').eq('id', attachmentId).eq('owner_id', auth.userId).is('deleted_at', null).maybeSingle();
  if (row.error || !row.data) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
  await findAuthorizedNote(auth, String(row.data.note_id));
  await enforceRequestBudget('attachment-processing', `user:${auth.userId}`);
  context.set('limitDecision', 'attachment-processing-allowed');
  const begun = await serviceClient.rpc('qnotes_begin_attachment_verification', { p_owner_id: auth.userId, p_attachment_id: attachmentId });
  if (begun.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to begin attachment verification.');
  const begin = objectRecord(begun.data);
  const beginStatus = String(begin.status ?? '');
  if (beginStatus === 'not_found') throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
  if (beginStatus === 'expired') throw new ApiError(409, 'ATTACHMENT_UPLOAD_EXPIRED', 'The attachment upload expired before finalization.');
  if (beginStatus === 'verifying' && begin.claimed !== true) throw new ApiError(409, 'ATTACHMENT_VERIFYING', 'The attachment is already being verified.');
  if (begin.claimed !== true) {
    const fresh = await appDbClient.from('attachments').select('*').eq('id', attachmentId).single();
    if (fresh.error || !fresh.data) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to read the attachment status.');
    return statusResponse(context, attachmentFromRow(objectRecord(fresh.data)));
  }

  const bucket = String(row.data.bucket);
  const stagingPath = String(begin.stagingPath ?? '');
  const finalPath = String(begin.objectPath ?? row.data.object_path);
  const object = await serviceClient.storage.from(bucket).download(stagingPath);
  if (object.error || !object.data) {
    await failVerification(auth.userId, attachmentId, 'ATTACHMENT_NOT_UPLOADED', 'pending_upload');
    throw new ApiError(409, 'ATTACHMENT_NOT_UPLOADED', 'The attachment has not been uploaded.');
  }
  const bytes = new Uint8Array(await object.data.arrayBuffer());
  const declaredSizeBytes = Number(row.data.size_bytes);
  const sizeCheck = validateUploadedAttachmentSize(declaredSizeBytes, bytes.byteLength, attachmentMaxBytes());
  if (!sizeCheck.ok) {
    await failVerification(auth.userId, attachmentId, sizeCheck.reason === 'too_large' ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_SIZE_MISMATCH');
    if (sizeCheck.reason === 'too_large') throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The uploaded attachment exceeds the configured size limit.');
    throw new ApiError(422, 'ATTACHMENT_SIZE_MISMATCH', 'The uploaded attachment size does not match its declared size.');
  }
  const signature = validateAttachmentSignature(String(row.data.mime_type), bytes);
  if (!signature.ok) {
    await failVerification(auth.userId, attachmentId, 'ATTACHMENT_TYPE_MISMATCH');
    throw new ApiError(422, 'ATTACHMENT_TYPE_MISMATCH', 'The uploaded attachment bytes do not match the declared type.');
  }
  const checksum = await sha256Bytes(bytes);
  try {
    await ensureFinalObject(bucket, finalPath, String(row.data.mime_type), bytes);
  } catch (error) {
    const cleanup = finalPath === stagingPath ? 'removed' : await removeAttachmentObjectsOrScheduleDeletion(auth.userId, attachmentId, bucket, [finalPath]);
    if (cleanup === 'removed') await failVerification(auth.userId, attachmentId, error instanceof Error && error.message === 'FINAL_OBJECT_CONFLICT' ? 'ATTACHMENT_FINAL_OBJECT_CONFLICT' : 'ATTACHMENT_INTEGRITY_MISMATCH');
    throw new ApiError(422, 'ATTACHMENT_INTEGRITY_MISMATCH', 'The verified attachment bytes could not be promoted safely.');
  }
  const result = await serviceClient.rpc('qnotes_finalize_attachment', { p_owner_id: auth.userId, p_attachment_id: attachmentId, p_checksum_sha256: checksum, p_generation: begin.generation });
  if (result.error) {
    const cleanup = finalPath === stagingPath ? 'removed' : await removeAttachmentObjectsOrScheduleDeletion(auth.userId, attachmentId, bucket, [finalPath]);
    if (cleanup === 'removed') await failVerification(auth.userId, attachmentId, 'ATTACHMENT_FINALIZE_FAILED');
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to finalize the attachment.');
  }
  const finalized = objectRecord(result.data);
  if (String(finalized.status) === 'generation_conflict') {
    const cleanup = finalPath === stagingPath ? 'removed' : await removeAttachmentObjectsOrScheduleDeletion(auth.userId, attachmentId, bucket, [finalPath]);
    if (cleanup === 'removed') await failVerification(auth.userId, attachmentId, 'ATTACHMENT_GENERATION_CONFLICT');
    throw new ApiError(409, 'ATTACHMENT_GENERATION_CONFLICT', 'The attachment changed during verification.');
  }
  if (String(finalized.status) === 'invalid_checksum') {
    const cleanup = finalPath === stagingPath ? 'removed' : await removeAttachmentObjectsOrScheduleDeletion(auth.userId, attachmentId, bucket, [finalPath]);
    if (cleanup === 'removed') await failVerification(auth.userId, attachmentId, 'ATTACHMENT_INVALID_CHECKSUM');
    throw new ApiError(500, 'INTERNAL_ERROR', 'The attachment digest was rejected.');
  }
  if (String(finalized.status) !== 'ok' && !['queued', 'processing', 'ready'].includes(String(finalized.status))) {
    const cleanup = finalPath === stagingPath ? 'removed' : await removeAttachmentObjectsOrScheduleDeletion(auth.userId, attachmentId, bucket, [finalPath]);
    if (cleanup === 'removed') await failVerification(auth.userId, attachmentId, 'ATTACHMENT_FINALIZE_CONFLICT');
    throw new ApiError(409, 'ATTACHMENT_FINALIZE_CONFLICT', 'The attachment could not be finalized from its current state.');
  }
  if (stagingPath !== finalPath) await serviceClient.storage.from(bucket).remove([stagingPath]);
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
  await findAuthorizedNote(auth, String(data.note_id));
  const signed = await serviceClient.storage.from(data.bucket).createSignedUrl(data.object_path, 60);
  if (signed.error || !signed.data?.signedUrl) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create an attachment download URL.');
  return statusResponse(context, { signedUrl: browserStorageUrl(signed.data.signedUrl), expiresInSeconds: 60 });
}

export async function deleteAttachment(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'attachments:write');
  const attachmentId = context.req.param('attachmentId');
  if (!isUUID(attachmentId)) throw new ApiError(422, 'VALIDATION_ERROR', 'attachmentId must be a valid UUID.');
  const { data, error } = await appDbClient.from('attachments').select('*').eq('id', attachmentId).eq('owner_id', auth.userId).is('deleted_at', null).maybeSingle();
  if (error || !data) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
  await findAuthorizedNote(auth, String(data.note_id));
  const requested = await serviceClient.rpc('qnotes_request_attachment_deletion', { p_owner_id: auth.userId, p_attachment_id: attachmentId });
  if (requested.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to start attachment deletion.');
  const deletion = objectRecord(requested.data);
  if (String(deletion.status) === 'not_found') throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
  const paths = uniquePaths(deletion.objectPath, deletion.stagingPath);
  const removed = paths.length ? await serviceClient.storage.from(String(deletion.bucket ?? data.bucket)).remove(paths) : { error: null };
  if (!removed.error) {
    const completed = await serviceClient.rpc('qnotes_complete_attachment_deletion', { p_owner_id: auth.userId, p_attachment_id: attachmentId });
    if (!completed.error) return statusResponse(context, null);
  }
  return statusResponse(context, { status: 'deleting' }, 202);
}
