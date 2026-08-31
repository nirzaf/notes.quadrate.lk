import type {
  ApiTokenScope,
  CreateApiTokenInput,
  CreateNoteInput,
  SearchMode,
  UpdateNoteInput,
  UUID,
  VersionedNoteMutationInput,
} from './contracts.js';
import { QNotesValidationError } from './errors.js';

export const MAX_MARKDOWN_CODE_UNITS = 2_000_000;
export const MAX_NOTE_LIST_LIMIT = 100;
export const DEFAULT_NOTE_LIST_LIMIT = 50;
export const MAX_SYNC_LIMIT = 500;
export const DEFAULT_SYNC_LIMIT = 200;
export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const TOKEN_SCOPES: ApiTokenScope[] = ['notes:read', 'notes:write', 'search:read', 'attachments:read', 'attachments:write'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUUID(value: unknown): value is UUID {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function requireUUID(value: unknown, field: string): UUID {
  if (!isUUID(value)) throw new QNotesValidationError(`${field} must be a valid UUID.`);
  return value;
}

export function normalizeMarkdown(value: unknown): string {
  if (typeof value !== 'string') throw new QNotesValidationError('contentMarkdown must be a string.');
  const normalized = value.replace(/\r\n?/g, '\n');
  if (normalized.length > MAX_MARKDOWN_CODE_UNITS) throw new QNotesValidationError('contentMarkdown is too large.');
  return normalized;
}

export function normalizeTags(value: unknown, optional = true): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw new QNotesValidationError('tags must be an array of strings.');
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new QNotesValidationError('Every tag must be a string.');
    const tag = item.trim().toLowerCase();
    if (!tag) throw new QNotesValidationError('Tags cannot be empty.');
    if (tag.length > 64) throw new QNotesValidationError('Tags must be 64 characters or fewer.');
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > 50) throw new QNotesValidationError('A note may have at most 50 tags.');
  return tags;
}

export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') throw new QNotesValidationError('title must be a string.');
  const title = value.trim();
  if (title.length < 1 || title.length > 200) throw new QNotesValidationError('title must contain 1 to 200 characters.');
  return title;
}

export function deriveSlug(title: string, noteId?: UUID): string {
  const slug = title.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug || `note-${noteId ? noteId.slice(0, 8).toLowerCase() : 'untitled'}`;
}

export function normalizeSlug(value: unknown, title: string, noteId?: UUID): string {
  if (value === undefined) return deriveSlug(title, noteId);
  if (typeof value !== 'string') throw new QNotesValidationError('slug must be a string.');
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw new QNotesValidationError('slug may contain only lowercase letters, numbers, hyphens, and underscores.');
  return slug;
}

export function validateCreateNoteInput(value: unknown): CreateNoteInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  const title = normalizeTitle(value.title);
  const contentMarkdown = value.contentMarkdown === undefined ? '' : normalizeMarkdown(value.contentMarkdown);
  const tags = normalizeTags(value.tags);
  const deviceId = requireUUID(value.deviceId, 'deviceId');
  const mutationId = requireUUID(value.mutationId, 'mutationId');
  const slug = value.slug === undefined ? undefined : normalizeSlug(value.slug, title);
  return { title, ...(slug ? { slug } : {}), contentMarkdown, tags, deviceId, mutationId };
}

export function validateUpdateNoteInput(value: unknown): UpdateNoteInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  const title = normalizeTitle(value.title);
  const slug = normalizeSlug(value.slug, title);
  const contentMarkdown = normalizeMarkdown(value.contentMarkdown);
  const tags = normalizeTags(value.tags, false);
  const expectedVersion = value.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new QNotesValidationError('expectedVersion must be a positive integer.');
  const deviceId = requireUUID(value.deviceId, 'deviceId');
  const mutationId = requireUUID(value.mutationId, 'mutationId');
  return { title, slug, contentMarkdown, tags, expectedVersion, deviceId, mutationId };
}

export function validateVersionedMutation(value: unknown): VersionedNoteMutationInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  const expectedVersion = value.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new QNotesValidationError('expectedVersion must be a positive integer.');
  return { expectedVersion, deviceId: requireUUID(value.deviceId, 'deviceId'), mutationId: requireUUID(value.mutationId, 'mutationId') };
}

export function validateSearchQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new QNotesValidationError('Search query cannot be empty.');
  const query = value.trim();
  if (query.length > MAX_SEARCH_QUERY_LENGTH) throw new QNotesValidationError('Search query is too long.');
  return query;
}

export function validateSearchMode(value: unknown): SearchMode {
  if (value === 'keyword' || value === 'semantic' || value === 'hybrid') return value;
  throw new QNotesValidationError('mode must be keyword, semantic, or hybrid.');
}

export function validateLimit(value: unknown, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new QNotesValidationError(`limit must be an integer from 1 to ${max}.`);
  return parsed;
}

export function validateTokenInput(value: unknown): CreateApiTokenInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new QNotesValidationError('Token name must contain 1 to 80 characters.');
  if (!Array.isArray(value.scopes) || value.scopes.length < 1) throw new QNotesValidationError('At least one token scope is required.');
  const scopes: ApiTokenScope[] = [];
  for (const scope of value.scopes) {
    if (typeof scope !== 'string' || !TOKEN_SCOPES.includes(scope as ApiTokenScope)) throw new QNotesValidationError('Token scope is invalid.');
    if (!scopes.includes(scope as ApiTokenScope)) scopes.push(scope as ApiTokenScope);
  }
  if (value.expiresAt !== null && value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt)))) throw new QNotesValidationError('expiresAt must be an ISO date or null.');
  return { name: value.name.trim(), scopes, expiresAt: value.expiresAt === undefined ? null : value.expiresAt as string | null };
}
