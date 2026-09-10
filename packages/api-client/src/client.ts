import type {
  ApiTokenMetadata,
  ApiTokenAccess,
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
import { createRequestSignal, redactSensitive, requestSecrets, throwIfAborted, validateApiEndpoint } from './endpoint-policy.ts';

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
  allowInsecureLoopback?: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  vaultApproval?: { approvalToken: string; requestHash: string };
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

export interface ContentReadParams extends RequestOptions {
  offset?: number;
  lineStart?: number;
  lineEnd?: number;
  maxBytes?: number;
  continuation?: string;
}

export interface GetNoteParams extends ContentReadParams {
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
  maxBytes?: number;
  continuation?: string;
}

export type BlockReadParams = ContentReadParams;
export type PublicShareReadParams = ContentReadParams;

export interface WorkspaceImportOptions extends RequestOptions {
  confirm?: boolean;
}

export interface WorkspaceImportSummary {
  dryRun: boolean;
  ready: boolean;
  message: string;
  format: string;
  formatVersion: number;
  backupId: UUID;
  compressedBytes: number;
  declaredUncompressedBytes: number;
  entries: number;
  uncompressedBytes: number;
  noteMarkdownBytes: number;
  attachmentBytes: number;
  conflicts: unknown[];
  unsupportedFiles: string[];
  validationFailures: string[];
  notebooks: number;
  notes: number;
  attachments: number;
}

type Success<T> = { data: T };

const SEARCH_SOURCE_TYPES = new Set(['note_metadata', 'note_chunk', 'copy_block', 'code_block', 'attachment_chunk']);
const SEARCH_MODES = new Set(['keyword', 'semantic', 'hybrid']);
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

function isContentContinuation(value: unknown): boolean {
  return isRecord(value) && isString(value.cursor) && isString(value.sourceHash)
    && typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0
    && typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0
    && (value.noteVersion === undefined || (typeof value.noteVersion === 'number' && Number.isSafeInteger(value.noteVersion) && value.noteVersion > 0));
}

function isNote(value: unknown): value is Note {
  return isRecord(value) && isString(value.id) && isString(value.slug) && isString(value.title)
    && isString(value.contentMarkdown) && isString(value.contentPlain) && isStringArray(value.tags)
    && isNullableString(value.notebookId) && typeof value.version === 'number' && Number.isSafeInteger(value.version)
    && isString(value.createdAt) && isString(value.updatedAt) && isNullableString(value.deletedAt)
    && (value.contentBytes === undefined || (typeof value.contentBytes === 'number' && Number.isSafeInteger(value.contentBytes) && value.contentBytes >= 0))
    && (value.totalBytes === undefined || (typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0))
    && (value.offset === undefined || (typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0))
    && (value.nextOffset === undefined || (typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0))
    && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.contentComplete === undefined || typeof value.contentComplete === 'boolean')
    && (value.sourceHash === undefined || isString(value.sourceHash))
    && (value.continuation === undefined || isContentContinuation(value.continuation));
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

function isWorkspaceImportSummary(value: unknown): value is WorkspaceImportSummary {
  return isRecord(value) && typeof value.dryRun === 'boolean' && typeof value.ready === 'boolean'
    && isString(value.message) && isString(value.format) && typeof value.formatVersion === 'number'
    && isString(value.backupId) && Number.isSafeInteger(value.compressedBytes)
    && Number.isSafeInteger(value.declaredUncompressedBytes) && Number.isSafeInteger(value.entries)
    && Number.isSafeInteger(value.uncompressedBytes) && Number.isSafeInteger(value.noteMarkdownBytes)
    && Number.isSafeInteger(value.attachmentBytes) && Array.isArray(value.conflicts)
    && Array.isArray(value.unsupportedFiles) && value.unsupportedFiles.every(isString)
    && Array.isArray(value.validationFailures) && value.validationFailures.every(isString)
    && Number.isSafeInteger(value.notebooks) && Number.isSafeInteger(value.notes)
    && Number.isSafeInteger(value.attachments);
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
    && isString(value.contentHash)
    && (value.contentBytes === undefined || (typeof value.contentBytes === 'number' && Number.isSafeInteger(value.contentBytes) && value.contentBytes >= 0))
    && (value.totalBytes === undefined || (typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0))
    && (value.offset === undefined || (typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0))
    && (value.nextOffset === undefined || (typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0))
    && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.contentComplete === undefined || typeof value.contentComplete === 'boolean')
    && (value.continuation === undefined || isContentContinuation(value.continuation));
}

function isSearchContextSource(value: unknown): boolean {
  return isRecord(value) && isString(value.documentId) && isString(value.noteId)
    && typeof value.noteVersion === 'number' && Number.isSafeInteger(value.noteVersion)
    && isString(value.sourceType) && SEARCH_SOURCE_TYPES.has(value.sourceType)
    && isNullableString(value.sourceId) && isString(value.sourceKey) && isString(value.sourceTitle)
    && isNullableString(value.headingPath) && isNullableString(value.attachmentId)
    && isNullableNumber(value.pageNumber) && isString(value.content) && isString(value.sourceHash)
    && typeof value.truncated === 'boolean'
    && (value.contentBytes === undefined || (typeof value.contentBytes === 'number' && Number.isSafeInteger(value.contentBytes) && value.contentBytes >= 0))
    && (value.totalBytes === undefined || (typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0))
    && (value.offset === undefined || (typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0));
}

function isSearchContextTokenBudget(value: unknown): boolean {
  return isRecord(value) && typeof value.max === 'number' && Number.isSafeInteger(value.max) && value.max >= 0
    && typeof value.used === 'number' && Number.isSafeInteger(value.used) && value.used >= 0 && value.used <= value.max
    && value.unit === 'approximate_tokens';
}

function isSearchContextContinuation(value: unknown): boolean {
  return isRecord(value) && isString(value.cursor) && typeof value.noteVersion === 'number'
    && Number.isSafeInteger(value.noteVersion) && isString(value.sourceHash)
    && typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0
    && (value.totalBytes === undefined || (typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0))
    && (value.principal === undefined || isString(value.principal))
    && (value.policyRevision === undefined || (typeof value.policyRevision === 'number' && Number.isSafeInteger(value.policyRevision) && value.policyRevision >= 0));
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
    && (value.contentBytes === undefined || (typeof value.contentBytes === 'number' && Number.isSafeInteger(value.contentBytes) && value.contentBytes >= 0))
    && (value.totalBytes === undefined || (typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0))
    && (value.offset === undefined || (typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0))
    && (value.nextOffset === undefined || (typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0))
    && (value.wireBytes === undefined || (typeof value.wireBytes === 'number' && Number.isSafeInteger(value.wireBytes) && value.wireBytes >= 0))
    && (value.wireByteLimit === undefined || (typeof value.wireByteLimit === 'number' && Number.isSafeInteger(value.wireByteLimit) && value.wireByteLimit > 0))
    && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.contentComplete === undefined || typeof value.contentComplete === 'boolean')
    && (value.neighborsTruncated === undefined || typeof value.neighborsTruncated === 'boolean')
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

function isTokenAccess(value: unknown): value is ApiTokenAccess {
  return isRecord(value) && (value.mode === 'account' || value.mode === 'notebooks')
    && isStringArray(value.notebookIds) && typeof value.allowUnfiled === 'boolean';
}

function isTokenMetadata(value: unknown): value is ApiTokenMetadata {
  return isRecord(value) && isString(value.id) && isString(value.name) && isString(value.tokenPrefix)
    && isStringArray(value.scopes) && isTokenAccess(value.access) && isNullableString(value.expiresAt) && isNullableString(value.lastUsedAt)
    && isNullableString(value.revokedAt) && isString(value.createdAt);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isPublicSharedNote(value: unknown): value is PublicSharedNote {
  if (!isRecord(value) || !isString(value.title) || !isString(value.contentMarkdown) || !isString(value.updatedAt)) return false;
  const allowed = ['title', 'contentMarkdown', 'updatedAt', 'contentBytes', 'totalBytes', 'offset', 'nextOffset', 'truncated', 'contentComplete', 'sourceHash', 'continuation'];
  return Object.keys(value).every((key) => allowed.includes(key))
    && (value.contentBytes === undefined || (typeof value.contentBytes === 'number' && Number.isSafeInteger(value.contentBytes) && value.contentBytes >= 0))
    && (value.totalBytes === undefined || (typeof value.totalBytes === 'number' && Number.isSafeInteger(value.totalBytes) && value.totalBytes >= 0))
    && (value.offset === undefined || (typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0))
    && (value.nextOffset === undefined || (typeof value.nextOffset === 'number' && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0))
    && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.contentComplete === undefined || typeof value.contentComplete === 'boolean')
    && (value.sourceHash === undefined || isString(value.sourceHash))
    && (value.continuation === undefined || isContentContinuation(value.continuation));
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

function keepRequestAliveUntilBodyConsumed(response: Response, cleanup: () => void): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = response.body!.getReader();
      const pump = async (): Promise<void> => {
        try {
          const result = await reader!.read();
          if (result.done) {
            cleanup();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
          await pump();
        } catch (error) {
          cleanup();
          controller.error(error);
        }
      };
      void pump();
    },
    cancel(reason) {
      cleanup();
      return reader?.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export class QNotesClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: QNotesClientOptions['getAccessToken'];
  private readonly fetchImplementation: typeof fetch;

  constructor(options: QNotesClientOptions) {
    this.baseUrl = validateApiEndpoint(options.baseUrl, options.allowInsecureLoopback === undefined ? {} : { allowInsecureLoopback: options.allowInsecureLoopback }).replace(/\/+$/, '');
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
      const secrets = requestSecrets(init.body, token);
      const response = await this.fetchImplementation(`${this.baseUrl}/api${path}`, {
        ...init,
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: requestSignal.signal,
      });
      throwIfAborted(requestSignal.signal);
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
        throwIfAborted(requestSignal.signal);
        const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
        const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
        const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
        throw new QNotesHttpError(response.status, code as QNotesHttpError['code'], typeof error.message === 'string' ? redactSensitive(error.message, secrets) as string : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? redactSensitive(error.requestId, secrets) as string : redactSensitive(response.headers.get('x-request-id') ?? '', secrets) as string, redactSensitive(error.details, secrets));
      }
      const body: unknown = await response.json();
      throwIfAborted(requestSignal.signal);
      if (typeof body !== 'object' || body === null || !('data' in body)) throw new Error('QNotes API returned an invalid success envelope.');
      return { data: (body as Success<T>).data, response };
    } catch (error) {
      throwIfAborted(requestSignal.signal);
      if (error instanceof QNotesHttpError || error instanceof QNotesProtocolError) throw error;
      throw new Error('QNotes request failed.');
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
      const secrets = requestSecrets(init.body);
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: requestSignal.signal,
      });
      throwIfAborted(requestSignal.signal);
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
        throwIfAborted(requestSignal.signal);
        const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
        const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
        const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
        throw new QNotesHttpError(response.status, code as QNotesHttpError['code'], typeof error.message === 'string' ? redactSensitive(error.message, secrets) as string : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? redactSensitive(error.requestId, secrets) as string : redactSensitive(response.headers.get('x-request-id') ?? '', secrets) as string, redactSensitive(error.details, secrets));
      }
      const body: unknown = await response.json();
      throwIfAborted(requestSignal.signal);
      if (typeof body !== 'object' || body === null || !('data' in body)) throw new Error('QNotes API returned an invalid success envelope.');
      return { data: (body as Success<T>).data, response };
    } catch (error) {
      throwIfAborted(requestSignal.signal);
      if (error instanceof QNotesHttpError || error instanceof QNotesProtocolError) throw error;
      throw new Error('QNotes request failed.');
    } finally {
      requestSignal.cleanup();
    }
  }

  private async publicRequestValidated<T>(path: string, validator: (value: unknown) => value is T, resource: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    return isValid((await this.publicRequestWithResponse<unknown>(path, init, options)).data, validator, resource);
  }

  private async binary(path: string, options: RequestOptions = {}): Promise<Response> {
    const requestSignal = createRequestSignal(options.signal, options.timeoutMs);
    let bodyOwnedByCaller = false;
    try {
      throwIfAborted(requestSignal.signal);
      const headers = new Headers({ Accept: '*/*' });
      const token = await this.getAccessToken(requestSignal.signal);
      throwIfAborted(requestSignal.signal);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const secrets = requestSecrets(undefined, token);
      const response = await this.fetchImplementation(`${this.baseUrl}/api${path}`, {
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: requestSignal.signal,
      });
      throwIfAborted(requestSignal.signal);
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
        throwIfAborted(requestSignal.signal);
        const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
        const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
        throw new QNotesHttpError(response.status, (typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR') as QNotesHttpError['code'], typeof error.message === 'string' ? redactSensitive(error.message, secrets) as string : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? redactSensitive(error.requestId, secrets) as string : redactSensitive(response.headers.get('x-request-id') ?? '', secrets) as string, redactSensitive(error.details, secrets));
      }
      const result = keepRequestAliveUntilBodyConsumed(response, requestSignal.cleanup);
      bodyOwnedByCaller = true;
      return result;
    } catch (error) {
      throwIfAborted(requestSignal.signal);
      if (error instanceof QNotesHttpError) throw error;
      throw new Error('QNotes request failed.');
    } finally {
      if (!bodyOwnedByCaller) requestSignal.cleanup();
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
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}${queryString({ includeDeleted: params.includeDeleted, offset: params.offset, lineStart: params.lineStart, lineEnd: params.lineEnd, maxBytes: params.maxBytes, continuation: params.continuation })}`, isNote, 'note', {}, params);
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

  getBlock(noteRef: string, blockKey: string, options: BlockReadParams = {}): Promise<NoteBlock> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}/blocks/${encodeURIComponent(blockKey)}${queryString({ offset: options.offset, lineStart: options.lineStart, lineEnd: options.lineEnd, maxBytes: options.maxBytes, continuation: options.continuation })}`, isNoteBlock, 'note block', {}, options);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return this.requestValidated(`/search${queryString({ q: params.query, mode: params.mode, limit: params.limit, cursor: params.cursor })}`, isSearchResponse, 'search', {}, params);
  }

  searchPost(input: SearchRequest, options: SearchPostOptions = {}): Promise<SearchResponse> {
    return this.requestValidated('/search', isSearchResponse, 'search', { method: 'POST', body: JSON.stringify(input) }, options);
  }

  readNoteContext(documentId: UUID, params: NoteContextParams = {}): Promise<SearchContext> {
    return this.requestValidated(`/search/documents/${encodeURIComponent(documentId)}/context${queryString({ before: params.before ?? 1, after: params.after ?? 1, maxTokens: params.maxTokens ?? 1800, maxBytes: params.maxBytes, continuation: params.continuation })}`, isSearchContext, 'search context', {}, params);
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

  resolvePublicShare(token: string, options: PublicShareReadParams = {}): Promise<PublicSharedNote> {
    const { offset, lineStart, lineEnd, maxBytes, continuation } = options;
    return this.publicRequestValidated('/public/share/resolve', isPublicSharedNote, 'public shared note', { method: 'POST', body: JSON.stringify({ token, ...(offset === undefined ? {} : { offset }), ...(lineStart === undefined ? {} : { lineStart }), ...(lineEnd === undefined ? {} : { lineEnd }), ...(maxBytes === undefined ? {} : { maxBytes }), ...(continuation === undefined ? {} : { continuation }) }) }, options);
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

  importWorkspace(archive: Uint8Array, options: WorkspaceImportOptions = {}): Promise<WorkspaceImportSummary> {
    const path = options.confirm ? '/import/workspace?confirm=true' : '/import/workspace';
    const { confirm: _confirm, ...requestOptions } = options;
    return this.requestValidated(path, isWorkspaceImportSummary, 'workspace import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: archive as unknown as BodyInit,
    }, requestOptions);
  }
}
