import type {
  ApiTokenMetadata,
  Attachment,
  AppendNoteInput,
  CreateApiTokenInput,
  CreateApiTokenResult,
  CreatePublicShareInput,
  CreatePublicShareResult,
  CreateNotebookInput,
  CreateNoteInput,
  Note,
  Notebook,
  NoteBlock,
  NoteSummary,
  PublicShareMetadata,
  PublicSharedNote,
  SearchContext,
  SearchMode,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SyncPage,
  UpdateNoteInput,
  UUID,
  VersionedNoteMutationInput,
} from '@qnotes/shared';
import { QNotesHttpError } from './http-error.ts';

export type CreateNoteOutcome = 'created' | 'idempotent' | 'deduplicated';
export type NoteMutationOutcome = 'applied' | 'idempotent';

export class QNotesProtocolError extends Error {
  constructor(resource: string) {
    super(`QNotes API returned a malformed ${resource} payload.`);
    this.name = 'QNotesProtocolError';
  }
}

export interface CreateNoteResult {
  note: Note;
  outcome: CreateNoteOutcome;
}

export interface NoteMutationResult {
  note: Note;
  outcome: NoteMutationOutcome;
}

export interface QNotesClientOptions {
  baseUrl: string;
  /**
   * The client passes the request signal to the provider when it can. A
   * provider that ignores the signal cannot be forcibly cancelled; the client
   * checks the signal again before sending the HTTP request.
   */
  getAccessToken: (signal?: AbortSignal) => string | null | Promise<string | null>;
  fetchImplementation?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ListNotesParams extends RequestOptions {
  cursor?: string;
  limit?: number;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  notebookId?: UUID;
  unfiled?: boolean;
  tag?: string;
}

export interface GetNoteParams extends RequestOptions {
  includeDeleted?: boolean;
}

export interface SearchParams extends RequestOptions {
  query: string;
  mode?: SearchMode;
  limit?: number;
  cursor?: string;
}

export interface SearchPostOptions extends RequestOptions {}

export interface NoteContextParams extends RequestOptions {
  before?: number;
  after?: number;
  maxTokens?: number;
  continuation?: string;
}

type Success<T> = { data: T };

const SEARCH_SOURCE_TYPES = new Set(['note_metadata', 'note_chunk', 'copy_block', 'code_block', 'attachment_chunk']);
const SEARCH_MODES = new Set(['keyword', 'semantic', 'hybrid']);
const MAX_REQUEST_TIMEOUT_MS = 120_000;

interface RequestSignal {
  signal?: AbortSignal;
  cleanup: () => void;
}

function boundedTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be a finite, non-negative number.');
  return Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS);
}

function requestTimeoutError(): DOMException {
  return new DOMException('The request timed out.', 'TimeoutError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function createRequestSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number | undefined): RequestSignal {
  const boundedMs = boundedTimeout(timeoutMs);
  if (boundedMs === undefined) return callerSignal ? { signal: callerSignal, cleanup: () => {} } : { cleanup: () => {} };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  if (!controller.signal.aborted) timer = setTimeout(() => controller.abort(requestTimeoutError()), boundedMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNote(value: unknown): value is Note {
  return isRecord(value) && isString(value.id) && isString(value.slug) && isString(value.title)
    && isString(value.contentMarkdown) && isString(value.contentPlain) && isStringArray(value.tags)
    && isNullableString(value.notebookId) && typeof value.version === 'number' && Number.isSafeInteger(value.version)
    && isString(value.createdAt) && isString(value.updatedAt) && isNullableString(value.deletedAt);
}

function isNoteSummary(value: unknown): value is NoteSummary {
  return isRecord(value) && isString(value.id) && isString(value.slug) && isString(value.title)
    && isString(value.excerpt) && isStringArray(value.tags) && isNullableString(value.notebookId)
    && typeof value.version === 'number' && Number.isSafeInteger(value.version)
    && isString(value.createdAt) && isString(value.updatedAt) && isNullableString(value.deletedAt);
}

function isNotebook(value: unknown): value is Notebook {
  return isRecord(value) && isString(value.id) && isString(value.name) && isString(value.createdAt) && isString(value.updatedAt);
}

function isAttachment(value: unknown): value is Attachment {
  return isRecord(value) && isString(value.id) && isString(value.noteId) && isString(value.originalFileName)
    && isString(value.mimeType) && typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes)
    && isString(value.status) && isNullableString(value.extractionError) && isString(value.createdAt) && isString(value.updatedAt);
}

function isSearchResult(value: unknown): value is SearchResult {
  return isRecord(value) && isString(value.id) && (value.documentId === undefined || isString(value.documentId))
    && isString(value.noteId) && (value.noteVersion === undefined || typeof value.noteVersion === 'number')
    && isString(value.noteSlug) && isString(value.noteTitle) && isString(value.sourceType)
    && SEARCH_SOURCE_TYPES.has(value.sourceType) && isNullableString(value.sourceId) && isString(value.sourceKey)
    && isString(value.sourceTitle) && isNullableString(value.headingPath) && isString(value.snippet)
    && typeof value.score === 'number' && Number.isFinite(value.score)
    && (value.keywordRank === null || typeof value.keywordRank === 'number')
    && (value.semanticRank === null || typeof value.semanticRank === 'number') && typeof value.copyable === 'boolean'
    && isNullableString(value.blockKey) && isNullableString(value.language) && isNullableString(value.attachmentId)
    && (value.tags === undefined || isStringArray(value.tags)) && (value.updatedAt === undefined || isString(value.updatedAt))
    && (value.matchReasons === undefined || isStringArray(value.matchReasons));
}

function isSearchResponse(value: unknown): value is SearchResponse {
  if (!isRecord(value) || !isString(value.queryId) || !isString(value.modeUsed) || !SEARCH_MODES.has(value.modeUsed) || typeof value.degraded !== 'boolean'
    || !isRecord(value.timing) || typeof value.timing.embeddingMs !== 'number' || typeof value.timing.retrievalMs !== 'number'
    || typeof value.timing.totalMs !== 'number'
    || (value.timing.metadataMs !== undefined && typeof value.timing.metadataMs !== 'number')
    || (value.timing.freshnessMs !== undefined && typeof value.timing.freshnessMs !== 'number')
    || (value.timing.serializationMs !== undefined && typeof value.timing.serializationMs !== 'number')
    || !Array.isArray(value.items) || !value.items.every(isSearchResult)) return false;
  if (value.nextCursor !== undefined && !isNullableString(value.nextCursor)) return false;
  if (value.degradedReason !== undefined && !isString(value.degradedReason)) return false;
  if (value.index !== undefined) {
    if (!isRecord(value.index) || !isString(value.index.model) || typeof value.index.pendingDocuments !== 'number'
      || typeof value.index.failedDocuments !== 'number' || !isNullableNumber(value.index.oldestPendingAgeSeconds)
      || typeof value.index.fresh !== 'boolean'
      || (value.index.freshness !== undefined && !['fresh', 'stale', 'unknown'].includes(value.index.freshness as string))) return false;
  }
  return true;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNoteBlock(value: unknown): value is NoteBlock {
  return isRecord(value) && isString(value.id) && isString(value.noteId) && isString(value.blockKey)
    && isString(value.blockType) && isNullableString(value.title) && isNullableString(value.language)
    && isString(value.content) && typeof value.position === 'number' && typeof value.copyable === 'boolean'
    && isString(value.contentHash);
}

function isSearchContextSource(value: unknown): boolean {
  return isRecord(value) && isString(value.documentId) && isString(value.noteId)
    && typeof value.noteVersion === 'number' && Number.isSafeInteger(value.noteVersion)
    && isString(value.sourceType) && SEARCH_SOURCE_TYPES.has(value.sourceType)
    && isNullableString(value.sourceId) && isString(value.sourceKey) && isString(value.sourceTitle)
    && isNullableString(value.headingPath) && isNullableString(value.attachmentId)
    && isNullableNumber(value.pageNumber) && isString(value.content) && isString(value.sourceHash)
    && typeof value.truncated === 'boolean';
}

function isSearchContextTokenBudget(value: unknown): boolean {
  return isRecord(value) && typeof value.max === 'number' && Number.isSafeInteger(value.max) && value.max >= 0
    && typeof value.used === 'number' && Number.isSafeInteger(value.used) && value.used >= 0 && value.used <= value.max
    && value.unit === 'approximate_tokens';
}

function isSearchContextContinuation(value: unknown): boolean {
  return isRecord(value) && isString(value.cursor) && typeof value.noteVersion === 'number'
    && Number.isSafeInteger(value.noteVersion) && isString(value.sourceHash)
    && typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0;
}

function isSearchContext(value: unknown): value is SearchContext {
  return isRecord(value) && isString(value.noteId) && typeof value.noteVersion === 'number' && isString(value.documentId)
    && isString(value.uri) && isString(value.title) && isNullableString(value.headingPath) && isString(value.content)
    && isStringArray(value.previous) && isStringArray(value.next) && isString(value.updatedAt) && isString(value.sourceType)
    && SEARCH_SOURCE_TYPES.has(value.sourceType) && (value.sourceId === undefined || isNullableString(value.sourceId))
    && (value.sourceKey === undefined || isString(value.sourceKey)) && (value.sourceTitle === undefined || isString(value.sourceTitle))
    && (value.attachmentId === undefined || isNullableString(value.attachmentId))
    && (value.pageNumber === undefined || isNullableNumber(value.pageNumber))
    && (value.sourceHash === undefined || isString(value.sourceHash))
    && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.tokenBudget === undefined || isSearchContextTokenBudget(value.tokenBudget))
    && (value.continuation === undefined || isSearchContextContinuation(value.continuation))
    && (value.previousSources === undefined || (Array.isArray(value.previousSources) && value.previousSources.every(isSearchContextSource)))
    && (value.nextSources === undefined || (Array.isArray(value.nextSources) && value.nextSources.every(isSearchContextSource)));
}

function isSyncPage(value: unknown): value is SyncPage {
  return isRecord(value) && Array.isArray(value.changes) && value.changes.every((change) => isRecord(change)
    && isString(change.noteId) && isString(change.slug) && isString(change.title) && isStringArray(change.tags)
    && isNullableString(change.notebookId) && typeof change.version === 'number' && isString(change.updatedAt)
    && isNullableString(change.deletedAt)) && isNullableString(value.nextCursor) && typeof value.hasMore === 'boolean';
}

function isTokenMetadata(value: unknown): value is ApiTokenMetadata {
  return isRecord(value) && isString(value.id) && isString(value.name) && isString(value.tokenPrefix)
    && isStringArray(value.scopes) && isNullableString(value.expiresAt) && isNullableString(value.lastUsedAt)
    && isNullableString(value.revokedAt) && isString(value.createdAt);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isPublicSharedNote(value: unknown): value is PublicSharedNote {
  return isRecord(value) && hasOnlyKeys(value, ['title', 'contentMarkdown', 'updatedAt'])
    && isString(value.title) && isString(value.contentMarkdown) && isString(value.updatedAt);
}

function isPublicShareMetadata(value: unknown): value is PublicShareMetadata {
  return isRecord(value) && hasOnlyKeys(value, ['id', 'noteId', 'tokenPrefix', 'expiresAt', 'revokedAt', 'createdAt'])
    && isString(value.id) && isString(value.noteId) && isString(value.tokenPrefix)
    && isNullableString(value.expiresAt) && isNullableString(value.revokedAt) && isString(value.createdAt);
}

function isCreatePublicShareResult(value: unknown): value is CreatePublicShareResult {
  return isRecord(value) && hasOnlyKeys(value, ['token', 'metadata']) && isString(value.token) && isPublicShareMetadata(value.metadata);
}

function isValid<T>(value: unknown, validator: (value: unknown) => value is T, resource: string): T {
  if (!validator(value)) throw new QNotesProtocolError(resource);
  return value;
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export class QNotesClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: QNotesClientOptions['getAccessToken'];
  private readonly fetchImplementation: typeof fetch;

  constructor(options: QNotesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = options.getAccessToken;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }

  private async requestWithResponse<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<{ data: T; response: Response }> {
    const requestSignal = createRequestSignal(options.signal ?? init.signal, options.timeoutMs);
    try {
      throwIfAborted(requestSignal.signal);
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      const token = await this.getAccessToken(requestSignal.signal);
      throwIfAborted(requestSignal.signal);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await this.fetchImplementation(`${this.baseUrl}/api${path}`, {
        ...init,
        headers,
        ...(requestSignal.signal ? { signal: requestSignal.signal } : {}),
      });
      throwIfAborted(requestSignal.signal);
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
        throwIfAborted(requestSignal.signal);
        const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
        const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
        const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
        throw new QNotesHttpError(response.status, code as QNotesHttpError['code'], typeof error.message === 'string' ? error.message : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id') ?? '', error.details);
      }
      const body: unknown = await response.json();
      throwIfAborted(requestSignal.signal);
      if (typeof body !== 'object' || body === null || !('data' in body)) throw new Error('QNotes API returned an invalid success envelope.');
      return { data: (body as Success<T>).data, response };
    } finally {
      requestSignal.cleanup();
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    return (await this.requestWithResponse<T>(path, init, options)).data;
  }

  private async requestValidated<T>(path: string, validator: (value: unknown) => value is T, resource: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    return isValid(await this.request<unknown>(path, init, options), validator, resource);
  }

  private async publicRequestWithResponse<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<{ data: T; response: Response }> {
    const requestSignal = createRequestSignal(options.signal ?? init.signal, options.timeoutMs);
    try {
      throwIfAborted(requestSignal.signal);
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        ...(requestSignal.signal ? { signal: requestSignal.signal } : {}),
      });
      throwIfAborted(requestSignal.signal);
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
        throwIfAborted(requestSignal.signal);
        const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
        const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
        const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
        throw new QNotesHttpError(response.status, code as QNotesHttpError['code'], typeof error.message === 'string' ? error.message : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id') ?? '', error.details);
      }
      const body: unknown = await response.json();
      throwIfAborted(requestSignal.signal);
      if (typeof body !== 'object' || body === null || !('data' in body)) throw new Error('QNotes API returned an invalid success envelope.');
      return { data: (body as Success<T>).data, response };
    } finally {
      requestSignal.cleanup();
    }
  }

  private async publicRequestValidated<T>(path: string, validator: (value: unknown) => value is T, resource: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    return isValid((await this.publicRequestWithResponse<unknown>(path, init, options)).data, validator, resource);
  }

  private async binary(path: string, options: RequestOptions = {}): Promise<Response> {
    const requestSignal = createRequestSignal(options.signal, options.timeoutMs);
    try {
      throwIfAborted(requestSignal.signal);
      const headers = new Headers({ Accept: '*/*' });
      const token = await this.getAccessToken(requestSignal.signal);
      throwIfAborted(requestSignal.signal);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await this.fetchImplementation(`${this.baseUrl}/api${path}`, {
        headers,
        ...(requestSignal.signal ? { signal: requestSignal.signal } : {}),
      });
      throwIfAborted(requestSignal.signal);
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
        throwIfAborted(requestSignal.signal);
        const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
        const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
        throw new QNotesHttpError(response.status, (typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR') as QNotesHttpError['code'], typeof error.message === 'string' ? error.message : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id') ?? '', error.details);
      }
      return response;
    } finally {
      requestSignal.cleanup();
    }
  }

  listNotes(params: ListNotesParams = {}): Promise<{ items: NoteSummary[]; nextCursor: string | null }> {
    return this.requestValidated(`/notes${queryString({ cursor: params.cursor, limit: params.limit, includeDeleted: params.includeDeleted, deletedOnly: params.deletedOnly, notebookId: params.notebookId, unfiled: params.unfiled, tag: params.tag })}`, (value): value is { items: NoteSummary[]; nextCursor: string | null } => isRecord(value) && Array.isArray(value.items) && value.items.every(isNoteSummary) && isNullableString(value.nextCursor), 'notes list', {}, params);
  }

  listNotebooks(options: RequestOptions = {}): Promise<{ items: Notebook[] }> {
    return this.requestValidated('/notebooks', (value): value is { items: Notebook[] } => isRecord(value) && Array.isArray(value.items) && value.items.every(isNotebook), 'notebooks list', {}, options);
  }

  createNotebook(input: CreateNotebookInput, options: RequestOptions = {}): Promise<Notebook> {
    return this.requestValidated('/notebooks', isNotebook, 'notebook', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  getNote(noteRef: string, params: GetNoteParams = {}): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}${queryString({ includeDeleted: params.includeDeleted })}`, isNote, 'note', {}, params);
  }

  createNote(input: CreateNoteInput, options: RequestOptions = {}): Promise<Note> {
    return this.requestValidated('/notes', isNote, 'note', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  async createNoteDetailed(input: CreateNoteInput, options: RequestOptions = {}): Promise<CreateNoteResult> {
    const result = await this.requestWithResponse<unknown>('/notes', { method: 'POST', body: JSON.stringify(input) }, options);
    const note = isValid(result.data, isNote, 'note');
    const outcome = result.response.headers.get('x-qnotes-create-outcome');
    if (outcome === 'created' || outcome === 'idempotent' || outcome === 'deduplicated') return { note, outcome };
    return { note, outcome: result.response.status === 201 ? 'created' : 'idempotent' };
  }

  private async noteMutationDetailed(path: string, method: 'PATCH' | 'POST' | 'DELETE', input: unknown, options: RequestOptions = {}): Promise<NoteMutationResult> {
    const result = await this.requestWithResponse<unknown>(path, { method, body: JSON.stringify(input) }, options);
    const note = isValid(result.data, isNote, 'note');
    const outcome = result.response.headers.get('x-qnotes-mutation-outcome');
    if (outcome === 'applied' || outcome === 'idempotent') return { note, outcome };
    // Older API deployments do not send the outcome header. Treat their
    // successful response as applied; never infer idempotency from a 200.
    return { note, outcome: 'applied' };
  }

  updateNote(noteId: UUID, input: UpdateNoteInput, options: RequestOptions = {}): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}`, isNote, 'note', { method: 'PATCH', body: JSON.stringify(input) }, options);
  }

  updateNoteDetailed(noteId: UUID, input: UpdateNoteInput, options: RequestOptions = {}): Promise<NoteMutationResult> {
    return this.noteMutationDetailed(`/notes/${encodeURIComponent(noteId)}`, 'PATCH', input, options);
  }

  appendNote(noteId: UUID, input: AppendNoteInput, options: RequestOptions = {}): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/append`, isNote, 'note', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  appendNoteDetailed(noteId: UUID, input: AppendNoteInput, options: RequestOptions = {}): Promise<NoteMutationResult> {
    return this.noteMutationDetailed(`/notes/${encodeURIComponent(noteId)}/append`, 'POST', input, options);
  }

  moveNoteToNotebook(noteId: UUID, input: { notebookId: UUID | null; expectedVersion: number; deviceId: UUID; mutationId: UUID }, options: RequestOptions = {}): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/notebook`, isNote, 'note', { method: 'PATCH', body: JSON.stringify(input) }, options);
  }

  deleteNote(noteId: UUID, input: VersionedNoteMutationInput, options: RequestOptions = {}): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}`, isNote, 'note', { method: 'DELETE', body: JSON.stringify(input) }, options);
  }

  deleteNoteDetailed(noteId: UUID, input: VersionedNoteMutationInput, options: RequestOptions = {}): Promise<NoteMutationResult> {
    return this.noteMutationDetailed(`/notes/${encodeURIComponent(noteId)}`, 'DELETE', input, options);
  }

  restoreNote(noteId: UUID, input: VersionedNoteMutationInput, options: RequestOptions = {}): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/restore`, isNote, 'note', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  restoreNoteDetailed(noteId: UUID, input: VersionedNoteMutationInput, options: RequestOptions = {}): Promise<NoteMutationResult> {
    return this.noteMutationDetailed(`/notes/${encodeURIComponent(noteId)}/restore`, 'POST', input, options);
  }

  listBlocks(noteRef: string, options: RequestOptions = {}): Promise<NoteBlock[]> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}/blocks`, (value): value is NoteBlock[] => Array.isArray(value) && value.every(isNoteBlock), 'note blocks', {}, options);
  }

  getBlock(noteRef: string, blockKey: string, options: RequestOptions = {}): Promise<NoteBlock> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}/blocks/${encodeURIComponent(blockKey)}`, isNoteBlock, 'note block', {}, options);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return this.requestValidated(`/search${queryString({ q: params.query, mode: params.mode, limit: params.limit, cursor: params.cursor })}`, isSearchResponse, 'search', {}, params);
  }

  searchPost(input: SearchRequest, options: SearchPostOptions = {}): Promise<SearchResponse> {
    return this.requestValidated('/search', isSearchResponse, 'search', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  readNoteContext(documentId: UUID, params: NoteContextParams = {}): Promise<SearchContext> {
    return this.requestValidated(`/search/documents/${encodeURIComponent(documentId)}/context${queryString({ before: params.before ?? 1, after: params.after ?? 1, maxTokens: params.maxTokens ?? 1800, continuation: params.continuation })}`, isSearchContext, 'search context', {}, params);
  }

  sync(cursor?: string, limit?: number, options: RequestOptions = {}): Promise<SyncPage> {
    return this.requestValidated(`/sync${queryString({ cursor, limit })}`, isSyncPage, 'sync', {}, options);
  }

  listAttachments(noteRef: string, options: RequestOptions = {}): Promise<Attachment[]> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}/attachments`, (value): value is Attachment[] => Array.isArray(value) && value.every(isAttachment), 'attachments', {}, options);
  }

  requestAttachmentUpload(input: { noteId: UUID; fileName: string; mimeType: string; sizeBytes: number }, options: RequestOptions = {}): Promise<{ attachment: Attachment; path: string; token: string }> {
    return this.requestValidated('/attachments/upload-url', (value): value is { attachment: Attachment; path: string; token: string } => isRecord(value) && isAttachment(value.attachment) && isString(value.path) && isString(value.token), 'attachment upload', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  finalizeAttachment(attachmentId: UUID, options: RequestOptions = {}): Promise<Attachment> {
    return this.requestValidated(`/attachments/${encodeURIComponent(attachmentId)}/finalize`, isAttachment, 'attachment', { method: 'POST' }, options);
  }

  async deleteAttachment(attachmentId: UUID, options: RequestOptions = {}): Promise<void> {
    await this.request(`/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }, options);
  }

  getAttachmentDownloadUrl(attachmentId: UUID, options: RequestOptions = {}): Promise<{ signedUrl: string; expiresInSeconds: 60 }> {
    return this.requestValidated(`/attachments/${encodeURIComponent(attachmentId)}`, (value): value is { signedUrl: string; expiresInSeconds: 60 } => isRecord(value) && isString(value.signedUrl) && value.expiresInSeconds === 60, 'attachment download', {}, options);
  }

  getPublicShare(noteId: UUID, options: RequestOptions = {}): Promise<PublicShareMetadata | null> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/share`, (value): value is PublicShareMetadata | null => value === null || isPublicShareMetadata(value), 'public share', {}, options);
  }

  createPublicShare(noteId: UUID, input: CreatePublicShareInput, options: RequestOptions = {}): Promise<CreatePublicShareResult> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/share`, isCreatePublicShareResult, 'public share', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  async revokePublicShare(noteId: UUID, options: RequestOptions = {}): Promise<void> {
    await this.request(`/notes/${encodeURIComponent(noteId)}/share`, { method: 'DELETE' }, options);
  }

  resolvePublicShare(token: string, options: RequestOptions = {}): Promise<PublicSharedNote> {
    return this.publicRequestValidated('/public/share/resolve', isPublicSharedNote, 'public shared note', { method: 'POST', body: JSON.stringify({ token }) }, options);
  }

  listTokens(options: RequestOptions = {}): Promise<ApiTokenMetadata[]> {
    return this.requestValidated('/tokens', (value): value is ApiTokenMetadata[] => Array.isArray(value) && value.every(isTokenMetadata), 'tokens', {}, options);
  }

  createToken(input: CreateApiTokenInput, options: RequestOptions = {}): Promise<CreateApiTokenResult> {
    return this.requestValidated('/tokens', (value): value is CreateApiTokenResult => isRecord(value) && isString(value.token) && isTokenMetadata(value.metadata), 'token', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  async revokeToken(tokenId: UUID, options: RequestOptions = {}): Promise<void> {
    await this.request(`/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' }, options);
  }

  exportNote(noteRef: string, options: RequestOptions = {}): Promise<Response> {
    return this.binary(`/export/note/${encodeURIComponent(noteRef)}`, options);
  }

  exportWorkspace(options: RequestOptions = {}): Promise<Response> {
    return this.binary('/export/workspace', options);
  }
}
