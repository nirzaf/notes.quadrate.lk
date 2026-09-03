import type {
  ApiTokenScope,
  CreateApiTokenInput,
  CreateNotebookInput,
  CreateNoteInput,
  MoveNoteToNotebookInput,
  ResolvedSearchMode,
  SearchFilters,
  SearchMode,
  SearchRequest,
  SearchSourceType,
  UpdateNoteInput,
  UUID,
  VersionedNoteMutationInput,
} from './contracts.ts';
import { QNotesValidationError } from './errors.ts';

export const MAX_MARKDOWN_CODE_UNITS = 2_000_000;
export const MAX_NOTE_LIST_LIMIT = 500;
export const DEFAULT_NOTE_LIST_LIMIT = 50;
export const MAX_SYNC_LIMIT = 500;
export const DEFAULT_SYNC_LIMIT = 200;
export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_NOTEBOOK_NAME_LENGTH = 80;
export const MAX_TITLE_LENGTH = 200;
export const MAX_SLUG_LENGTH = 80;
export const MAX_TAG_LENGTH = 64;
export const MAX_TAG_COUNT = 50;
export const MAX_BLOCK_KEY_LENGTH = 100;
export const MAX_TOKEN_NAME_LENGTH = 80;
export const MAX_DEDUPE_KEY_LENGTH = 200;

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
    if (tag.length > MAX_TAG_LENGTH) throw new QNotesValidationError(`Tags must be ${MAX_TAG_LENGTH} characters or fewer.`);
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAG_COUNT) throw new QNotesValidationError(`A note may have at most ${MAX_TAG_COUNT} tags.`);
  return tags;
}

export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') throw new QNotesValidationError('title must be a string.');
  const title = value.trim();
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) throw new QNotesValidationError(`title must contain 1 to ${MAX_TITLE_LENGTH} characters.`);
  return title;
}

export function normalizeNotebookName(value: unknown): string {
  if (typeof value !== 'string') throw new QNotesValidationError('name must be a string.');
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NOTEBOOK_NAME_LENGTH) throw new QNotesValidationError(`Notebook names must contain 1 to ${MAX_NOTEBOOK_NAME_LENGTH} characters.`);
  return name;
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
  const notebookId = value.notebookId === null || value.notebookId === undefined ? undefined : requireUUID(value.notebookId, 'notebookId');
  let dedupeKey: string | undefined;
  if (value.dedupeKey !== undefined) {
    if (typeof value.dedupeKey !== 'string' || !value.dedupeKey.trim() || value.dedupeKey.trim().length > MAX_DEDUPE_KEY_LENGTH) {
      throw new QNotesValidationError(`dedupeKey must contain 1 to ${MAX_DEDUPE_KEY_LENGTH} characters.`);
    }
    dedupeKey = value.dedupeKey.trim();
  }
  return { title, ...(slug ? { slug } : {}), contentMarkdown, tags, ...(notebookId !== undefined ? { notebookId } : {}), ...(dedupeKey ? { dedupeKey } : {}), deviceId, mutationId };
}

export function validateCreateNotebookInput(value: unknown): CreateNotebookInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  return { name: normalizeNotebookName(value.name) };
}

export function validateMoveNoteToNotebookInput(value: unknown): MoveNoteToNotebookInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  const expectedVersion = value.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new QNotesValidationError('expectedVersion must be a positive integer.');
  const notebookId = value.notebookId === null || value.notebookId === undefined ? null : requireUUID(value.notebookId, 'notebookId');
  return { notebookId, expectedVersion, deviceId: requireUUID(value.deviceId, 'deviceId'), mutationId: requireUUID(value.mutationId, 'mutationId') };
}

export function validateUpdateNoteInput(value: unknown): UpdateNoteInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  const title = normalizeTitle(value.title);
  const slug = normalizeSlug(value.slug, title);
  const contentMarkdown = normalizeMarkdown(value.contentMarkdown);
  const tags = value.tags === undefined ? undefined : normalizeTags(value.tags, false);
  const expectedVersion = value.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new QNotesValidationError('expectedVersion must be a positive integer.');
  const deviceId = requireUUID(value.deviceId, 'deviceId');
  const mutationId = requireUUID(value.mutationId, 'mutationId');
  return { title, slug, contentMarkdown, ...(tags !== undefined ? { tags } : {}), expectedVersion, deviceId, mutationId };
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
  if (value === 'auto' || value === 'keyword' || value === 'semantic' || value === 'hybrid') return value;
  throw new QNotesValidationError('mode must be auto, keyword, semantic, or hybrid.');
}

const SEARCH_SOURCE_TYPES: SearchSourceType[] = ['note_metadata', 'note_chunk', 'copy_block', 'code_block', 'attachment_chunk'];

function normalizeSearchFilters(value: unknown): SearchFilters {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new QNotesValidationError('filters must be an object.');
  const filters: SearchFilters = {};
  if (value.notebookIds !== undefined) {
    if (!Array.isArray(value.notebookIds) || value.notebookIds.length > 50) throw new QNotesValidationError('notebookIds must contain at most 50 UUIDs.');
    filters.notebookIds = value.notebookIds.map((item) => requireUUID(item, 'notebookId'));
  }
  if (value.tags !== undefined) filters.tags = normalizeTags(value.tags, false);
  if (value.sourceTypes !== undefined) {
    if (!Array.isArray(value.sourceTypes) || value.sourceTypes.length > SEARCH_SOURCE_TYPES.length) throw new QNotesValidationError('sourceTypes contains too many values.');
    const sourceTypes: SearchSourceType[] = [];
    for (const item of value.sourceTypes) {
      if (typeof item !== 'string' || !SEARCH_SOURCE_TYPES.includes(item as SearchSourceType)) throw new QNotesValidationError('sourceTypes contains an invalid value.');
      if (!sourceTypes.includes(item as SearchSourceType)) sourceTypes.push(item as SearchSourceType);
    }
    filters.sourceTypes = sourceTypes;
  }
  if (value.languages !== undefined) {
    if (!Array.isArray(value.languages) || value.languages.length > 50) throw new QNotesValidationError('languages must contain at most 50 values.');
    const languages: string[] = [];
    for (const item of value.languages) {
      if (typeof item !== 'string') throw new QNotesValidationError('languages must be strings.');
      const language = item.trim().toLowerCase();
      if (!language || language.length > 40) throw new QNotesValidationError('languages contain an invalid value.');
      if (!languages.includes(language)) languages.push(language);
    }
    filters.languages = languages;
  }
  if (value.updatedAfter !== undefined) {
    if (typeof value.updatedAfter !== 'string' || Number.isNaN(Date.parse(value.updatedAfter))) throw new QNotesValidationError('updatedAfter must be an ISO date.');
    filters.updatedAfter = value.updatedAfter;
  }
  if (value.unfiled !== undefined) {
    if (typeof value.unfiled !== 'boolean') throw new QNotesValidationError('unfiled must be a boolean.');
    filters.unfiled = value.unfiled;
  }
  return filters;
}

export function validateSearchRequest(value: unknown): SearchRequest {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  const request: SearchRequest = {
    query: validateSearchQuery(value.query),
    mode: validateSearchMode(value.mode ?? 'auto'),
    limit: validateLimit(value.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
    maxPerNote: validateLimit(value.maxPerNote, 2, 2),
    filters: normalizeSearchFilters(value.filters),
  };
  const relativeScore = value.minimumRelativeScore ?? value.minimumConfidence;
  if (relativeScore !== undefined) {
    if (typeof relativeScore !== 'number' || !Number.isFinite(relativeScore) || relativeScore < 0 || relativeScore > 1) throw new QNotesValidationError('minimumRelativeScore must be a number from 0 to 1.');
    request.minimumRelativeScore = relativeScore;
  }
  if (value.cursor !== undefined) {
    if (typeof value.cursor !== 'string' || !value.cursor.trim() || value.cursor.length > 500) throw new QNotesValidationError('cursor must be a non-empty string of at most 500 characters.');
    request.cursor = value.cursor;
  }
  return request;
}

const SEARCH_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/$@-]{0,79}$/;
const QUOTED_SEARCH_PATTERN = /^(?:"[^"\n]{1,500}"|'[^'\n]{1,500}')$/;

export function resolveAutoSearchMode(value: string): ResolvedSearchMode {
  const query = value.trim();
  if (UUID_PATTERN.test(query) || SEARCH_IDENTIFIER_PATTERN.test(query) || QUOTED_SEARCH_PATTERN.test(query)) return 'keyword';
  return 'hybrid';
}

export function validateLimit(value: unknown, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new QNotesValidationError(`limit must be an integer from 1 to ${max}.`);
  return parsed;
}

export function validateTokenInput(value: unknown): CreateApiTokenInput {
  if (!isRecord(value)) throw new QNotesValidationError('Request body must be an object.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > MAX_TOKEN_NAME_LENGTH) throw new QNotesValidationError(`Token name must contain 1 to ${MAX_TOKEN_NAME_LENGTH} characters.`);
  if (!Array.isArray(value.scopes) || value.scopes.length < 1) throw new QNotesValidationError('At least one token scope is required.');
  const scopes: ApiTokenScope[] = [];
  for (const scope of value.scopes) {
    if (typeof scope !== 'string' || !TOKEN_SCOPES.includes(scope as ApiTokenScope)) throw new QNotesValidationError('Token scope is invalid.');
    if (!scopes.includes(scope as ApiTokenScope)) scopes.push(scope as ApiTokenScope);
  }
  if (value.expiresAt !== null && value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt)))) throw new QNotesValidationError('expiresAt must be an ISO date or null.');
  return { name: value.name.trim(), scopes, expiresAt: value.expiresAt === undefined ? null : value.expiresAt as string | null };
}
