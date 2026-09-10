import type { Context } from 'hono';
import { isUUID, QNotesValidationError, validateCreatePublicShareInput } from '@qnotes/shared';
import { authFromContext, requireScope } from '../_shared/auth.ts';
import { appDbClient, assertSupabase, serviceClient } from '../_shared/database.ts';
import { ApiError } from '../_shared/errors.ts';
import { generateNoteShareToken, hashNoteShareToken, isValidNoteShareToken, noteShareTokenPrefix } from '../_shared/share-token.ts';
import { findAuthorizedNote } from './notes.ts';

const unavailableMessage = 'This shared note is unavailable. The link may be invalid, expired, or revoked.';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'VALIDATION_ERROR', 'A JSON object is required.');
  return value as Record<string, unknown>;
}

function metadata(row: Record<string, unknown>) {
  const noteId = row.note_id ?? row.noteId;
  const tokenPrefix = row.token_prefix ?? row.tokenPrefix;
  const expiresAt = row.expires_at ?? row.expiresAt;
  const revokedAt = row.revoked_at ?? row.revokedAt;
  const createdAt = row.created_at ?? row.createdAt;
  return {
    id: String(row.id),
    noteId: String(noteId),
    tokenPrefix: String(tokenPrefix),
    expiresAt: expiresAt ? String(expiresAt) : null,
    revokedAt: revokedAt ? String(revokedAt) : null,
    createdAt: String(createdAt),
  };
}

function ownerNoteId(context: Context): string {
  const noteId = context.req.param('noteId');
  if (!isUUID(noteId)) throw new ApiError(422, 'VALIDATION_ERROR', 'noteId must be a valid UUID.');
  return noteId;
}

function shareNotFound(): never {
  throw new ApiError(404, 'PUBLIC_SHARE_NOT_FOUND', unavailableMessage);
}

async function loadPublicSharedNote(token: unknown): Promise<{ title: string; content_markdown: string; updated_at: string }> {
  if (typeof token !== 'string' || !isValidNoteShareToken(token)) shareNotFound();
  const tokenHash = await hashNoteShareToken(token);
  const result = assertSupabase(await serviceClient.rpc('qnotes_resolve_note_share', { p_token_hash: tokenHash }));
  const row = Array.isArray(result) ? result[0] : null;
  if (!row || typeof row !== 'object' || Array.isArray(row)) shareNotFound();
  const resolved = record(row);
  if (typeof resolved.title !== 'string' || typeof resolved.content_markdown !== 'string' || typeof resolved.updated_at !== 'string') {
    throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to resolve public share.');
  }
  return { title: resolved.title, content_markdown: resolved.content_markdown, updated_at: resolved.updated_at };
}

export async function getPublicShare(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'shares:write');
  const noteId = ownerNoteId(context);
  await findAuthorizedNote(auth, noteId, true);
  const result = await appDbClient.from('note_shares').select('id, note_id, token_prefix, expires_at, revoked_at, created_at').eq('owner_id', auth.userId).eq('note_id', noteId).is('revoked_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to read public sharing settings.');
  return context.json({ data: result.data ? metadata(record(result.data)) : null });
}

export async function createPublicShare(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'shares:write');
  const noteId = ownerNoteId(context);
  const note = await findAuthorizedNote(auth, noteId);
  let input;
  try {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
    }
    input = validateCreatePublicShareInput(parseJsonObject(body));
  } catch (error: unknown) {
    if (error instanceof QNotesValidationError) throw new ApiError(422, 'VALIDATION_ERROR', error.message);
    throw error;
  }
  const token = generateNoteShareToken();
  const tokenHash = await hashNoteShareToken(token);
  const result = assertSupabase(await serviceClient.rpc('qnotes_create_note_share', {
    p_owner_id: auth.userId,
    p_note_id: note.id,
    p_token_prefix: noteShareTokenPrefix(token),
    p_token_hash: tokenHash,
    p_expires_at: input.expiresAt,
  }));
  const data = record(result);
  if (data.status === 'not_found') throw new ApiError(404, 'NOTE_NOT_FOUND', 'The note was not found.');
  if (data.status === 'invalid_expiry') throw new ApiError(422, 'VALIDATION_ERROR', 'expiresAt must be in the future and within one year.');
  if (data.status !== 'ok' || !data.share) throw new ApiError(500, 'INTERNAL_ERROR', 'Unable to create public share.');
  return context.json({ data: { token, metadata: metadata(record(data.share)) } }, 201);
}

export async function revokePublicShare(context: Context): Promise<Response> {
  const auth = authFromContext(context);
  requireScope(auth, 'shares:write');
  const noteId = ownerNoteId(context);
  await findAuthorizedNote(auth, noteId, true);
  assertSupabase(await serviceClient.rpc('qnotes_revoke_note_share', { p_owner_id: auth.userId, p_note_id: noteId }));
  return context.json({ data: null });
}

export async function resolvePublicShare(context: Context): Promise<Response> {
  const body = record(await context.req.json().catch(() => null));
  if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'token')) shareNotFound();
  const resolved = await loadPublicSharedNote(body.token);
  return context.json({ data: { title: resolved.title, contentMarkdown: resolved.content_markdown, updatedAt: resolved.updated_at } });
}
