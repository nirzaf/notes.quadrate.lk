import type { CreatePublicShareResult } from '@qnotes/api-client';
import type { Note, UUID } from '@qnotes/shared';
import { isUUID } from '@qnotes/shared';
import { toolResult } from './common.ts';
import { publicShareSchema } from '../contracts.ts';

const PUBLIC_SHARE_URL = 'https://notes.quadrate.lk/share#';
const PUBLIC_SHARE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_SHARE_TOKEN_PATTERN = /^qns_[A-Za-z0-9_-]{43}$/;

/**
 * This is deliberately a conservative, pattern-based publishing guard. It
 * blocks recognizable private keys, bearer/JWT values, connection strings,
 * known provider token formats, and non-empty values assigned to common
 * credential field names. It is not a secret scanner and must not be treated
 * as a substitute for a human review of the note before publishing.
 */
const SENSITIVE_CONTENT_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
  /\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+\S+/i,
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer[_ -]?token|client[_ -]?secret|service[_ -]?(?:key|token|password|secret)|private[_ -]?key|encryption[_ -]?key|database[_ -]?url|connection[_ -]?string)\s*[:=]\s*['"]?[^\s'"`]+/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|https?):\/\/[^\s'"`]+:[^\s'"`]+@/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:ghp|gho|ghs|ghr|glpat|github_pat)[_-][A-Za-z0-9_-]{12,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/i,
  /\bqnt_[A-Za-z0-9_-]{20,}\b/,
  /\bqns_[A-Za-z0-9_-]{20,}\b/,
  /(?:^|[^A-Za-z0-9_-])qvt_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export interface CreatePublicShareQNotesClient {
  getNote(noteId: UUID): Promise<Note>;
  createPublicShare(noteId: UUID, input: { expiresAt: string }): Promise<CreatePublicShareResult>;
}

export interface CreatePublicShareToolOptions {
  now?: () => Date;
}

export function containsSensitiveContent(title: string, contentMarkdown: string): boolean {
  const searchableContent = `${title}\n${contentMarkdown}`;
  return SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(searchableContent));
}

export async function createPublicShareTool(
  client: CreatePublicShareQNotesClient,
  args: { noteId: string },
  options: CreatePublicShareToolOptions = {},
) {
  if (!isUUID(args.noteId)) throw new Error('noteId must be a valid UUID.');

  const invokedAt = options.now?.() ?? new Date();
  if (Number.isNaN(invokedAt.getTime())) throw new Error('Unable to determine the share expiration time.');
  const expiresAt = new Date(invokedAt.getTime() + PUBLIC_SHARE_EXPIRY_MS).toISOString();
  const noteId = args.noteId;
  const note = await client.getNote(noteId);
  if (containsSensitiveContent(note.title, note.contentMarkdown)) {
    throw new Error('This note appears to contain sensitive credential material and cannot be publicly shared.');
  }

  const result = await client.createPublicShare(noteId, { expiresAt });
  if (!PUBLIC_SHARE_TOKEN_PATTERN.test(result.token)) throw new Error('QNotes API returned an invalid public share token.');
  return toolResult({ url: `${PUBLIC_SHARE_URL}${result.token}`, noteId, expiresAt }, publicShareSchema);
}
