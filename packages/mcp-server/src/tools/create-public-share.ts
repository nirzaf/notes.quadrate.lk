import type { CreatePublicShareResult } from '@qnotes/api-client';
import type { Note, UUID } from '@qnotes/shared';
import { classifyPublicShareContent, isUUID } from '@qnotes/shared';
import { toolResult } from './common.ts';
import { publicShareSchema } from '../contracts.ts';

const PUBLIC_SHARE_URL = 'https://notes.quadrate.lk/share#';
const PUBLIC_SHARE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_SHARE_TOKEN_PATTERN = /^qns_[A-Za-z0-9_-]{43}$/;

export interface CreatePublicShareQNotesClient {
  getNote(noteId: UUID): Promise<Note>;
  createPublicShare(noteId: UUID, input: { expectedVersion: number; expiresAt: string; confirm: true }): Promise<CreatePublicShareResult>;
}

export interface CreatePublicShareToolOptions {
  now?: () => Date;
}

export function containsSensitiveContent(title: string, contentMarkdown: string): boolean {
  return classifyPublicShareContent(title, contentMarkdown) === 'sensitive';
}

export async function createPublicShareTool(
  client: CreatePublicShareQNotesClient,
  args: { noteId: string; expectedVersion?: number; confirm?: true },
  options: CreatePublicShareToolOptions = {},
) {
  if (!isUUID(args.noteId)) throw new Error('noteId must be a valid UUID.');
  if (args.expectedVersion === undefined || args.confirm !== true) throw new Error('Public snapshot creation now requires expectedVersion and confirm=true after reviewing the saved note.');
  if (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1) throw new Error('expectedVersion must be a positive integer.');

  const invokedAt = options.now?.() ?? new Date();
  if (Number.isNaN(invokedAt.getTime())) throw new Error('Unable to determine the share expiration time.');
  const expiresAt = new Date(invokedAt.getTime() + PUBLIC_SHARE_EXPIRY_MS).toISOString();
  const noteId = args.noteId;
  const note = await client.getNote(noteId);
  if (note.version !== args.expectedVersion) throw new Error('The note changed after it was reviewed. Read the saved note again before publishing.');
  if (classifyPublicShareContent(note.title, note.contentMarkdown) === 'sensitive') {
    throw new Error('This note appears to contain sensitive credential material and cannot be publicly shared.');
  }

  const result = await client.createPublicShare(noteId, { expectedVersion: note.version, expiresAt, confirm: true });
  if (!PUBLIC_SHARE_TOKEN_PATTERN.test(result.token)) throw new Error('QNotes API returned an invalid public share token.');
  return toolResult({ url: `${PUBLIC_SHARE_URL}${result.token}`, noteId, expiresAt }, publicShareSchema);
}
