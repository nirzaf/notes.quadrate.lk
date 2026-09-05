import type {
  ApiTokenMetadata,
  Attachment,
  AppendNoteInput,
  CreateApiTokenInput,
  CreateApiTokenResult,
  CreateNotebookInput,
  CreateNoteInput,
  Note,
  Notebook,
  NoteBlock,
  NoteSummary,
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
import { QNotesHttpError } from './http-error.js';

export type CreateNoteOutcome = 'created' | 'idempotent' | 'deduplicated';

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

export interface QNotesClientOptions {
  baseUrl: string;
  getAccessToken: () => string | null | Promise<string | null>;
  fetchImplementation?: typeof fetch;
}

export interface ListNotesParams {
  cursor?: string;
  limit?: number;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  notebookId?: UUID;
  unfiled?: boolean;
  tag?: string;
  signal?: AbortSignal;
}

export interface GetNoteParams {
  includeDeleted?: boolean;
  signal?: AbortSignal;
}

export interface SearchParams {
  query: string;
  mode?: SearchMode;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface SearchPostOptions {
  signal?: AbortSignal;
}

export interface NoteContextParams {
  before?: number;
  after?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface RequestOptions {
  signal?: AbortSignal;
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
    || typeof value.timing.totalMs !== 'number' || !Array.isArray(value.items) || !value.items.every(isSearchResult)) return false;
  if (value.nextCursor !== undefined && !isNullableString(value.nextCursor)) return false;
  if (value.degradedReason !== undefined && !isString(value.degradedReason)) return false;
  if (value.index !== undefined) {
    if (!isRecord(value.index) || !isString(value.index.model) || typeof value.index.pendingDocuments !== 'number'
      || typeof value.index.failedDocuments !== 'number' || !isNullableNumber(value.index.oldestPendingAgeSeconds)
      || typeof value.index.fresh !== 'boolean') return false;
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

function isSearchContext(value: unknown): value is SearchContext {
  return isRecord(value) && isString(value.noteId) && typeof value.noteVersion === 'number' && isString(value.documentId)
    && isString(value.uri) && isString(value.title) && isNullableString(value.headingPath) && isString(value.content)
    && isStringArray(value.previous) && isStringArray(value.next) && isString(value.updatedAt) && isString(value.sourceType)
    && SEARCH_SOURCE_TYPES.has(value.sourceType) && (value.sourceId === undefined || isNullableString(value.sourceId))
    && (value.sourceKey === undefined || isString(value.sourceKey)) && (value.sourceTitle === undefined || isString(value.sourceTitle))
    && (value.attachmentId === undefined || isNullableString(value.attachmentId))
    && (value.pageNumber === undefined || isNullableNumber(value.pageNumber));
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

  private async requestWithResponse<T>(path: string, init: RequestInit = {}): Promise<{ data: T; response: Response }> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const token = await this.getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetchImplementation(`${this.baseUrl}/api${path}`, { ...init, headers });
    if (!response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
      const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
      const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
      const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
      throw new QNotesHttpError(response.status, code as QNotesHttpError['code'], typeof error.message === 'string' ? error.message : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id') ?? '', error.details);
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('data' in body)) throw new Error('QNotes API returned an invalid success envelope.');
    return { data: (body as Success<T>).data, response };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestWithResponse<T>(path, init)).data;
  }

  private async requestValidated<T>(path: string, validator: (value: unknown) => value is T, resource: string, init: RequestInit = {}): Promise<T> {
    return isValid(await this.request<unknown>(path, init), validator, resource);
  }

  private async binary(path: string): Promise<Response> {
    const headers = new Headers({ Accept: '*/*' });
    const token = await this.getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetchImplementation(`${this.baseUrl}/api${path}`, { headers });
    if (!response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      const body: unknown = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text().catch(() => '');
      const envelope = typeof body === 'object' && body !== null && 'error' in body ? (body as { error?: unknown }).error : null;
      const error = typeof envelope === 'object' && envelope !== null ? envelope as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown } : {};
      throw new QNotesHttpError(response.status, (typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR') as QNotesHttpError['code'], typeof error.message === 'string' ? error.message : `Request failed with HTTP ${response.status}.`, typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id') ?? '', error.details);
    }
    return response;
  }

  listNotes(params: ListNotesParams = {}): Promise<{ items: NoteSummary[]; nextCursor: string | null }> {
    return this.requestValidated(`/notes${queryString({ cursor: params.cursor, limit: params.limit, includeDeleted: params.includeDeleted, deletedOnly: params.deletedOnly, notebookId: params.notebookId, unfiled: params.unfiled, tag: params.tag })}`, (value): value is { items: NoteSummary[]; nextCursor: string | null } => isRecord(value) && Array.isArray(value.items) && value.items.every(isNoteSummary) && isNullableString(value.nextCursor), 'notes list', params.signal ? { signal: params.signal } : {});
  }

  listNotebooks(options: RequestOptions = {}): Promise<{ items: Notebook[] }> {
    return this.requestValidated('/notebooks', (value): value is { items: Notebook[] } => isRecord(value) && Array.isArray(value.items) && value.items.every(isNotebook), 'notebooks list', options.signal ? { signal: options.signal } : {});
  }

  createNotebook(input: CreateNotebookInput): Promise<Notebook> {
    return this.requestValidated('/notebooks', isNotebook, 'notebook', { method: 'POST', body: JSON.stringify(input) });
  }

  getNote(noteRef: string, params: GetNoteParams = {}): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}${queryString({ includeDeleted: params.includeDeleted })}`, isNote, 'note', params.signal ? { signal: params.signal } : {});
  }

  createNote(input: CreateNoteInput): Promise<Note> {
    return this.requestValidated('/notes', isNote, 'note', { method: 'POST', body: JSON.stringify(input) });
  }

  async createNoteDetailed(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.requestWithResponse<unknown>('/notes', { method: 'POST', body: JSON.stringify(input) });
    const note = isValid(result.data, isNote, 'note');
    const outcome = result.response.headers.get('x-qnotes-create-outcome');
    if (outcome === 'created' || outcome === 'idempotent' || outcome === 'deduplicated') return { note, outcome };
    return { note, outcome: result.response.status === 201 ? 'created' : 'idempotent' };
  }

  updateNote(noteId: UUID, input: UpdateNoteInput): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}`, isNote, 'note', { method: 'PATCH', body: JSON.stringify(input) });
  }

  appendNote(noteId: UUID, input: AppendNoteInput): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/append`, isNote, 'note', { method: 'POST', body: JSON.stringify(input) });
  }

  moveNoteToNotebook(noteId: UUID, input: { notebookId: UUID | null; expectedVersion: number; deviceId: UUID; mutationId: UUID }): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/notebook`, isNote, 'note', { method: 'PATCH', body: JSON.stringify(input) });
  }

  deleteNote(noteId: UUID, input: VersionedNoteMutationInput): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}`, isNote, 'note', { method: 'DELETE', body: JSON.stringify(input) });
  }

  restoreNote(noteId: UUID, input: VersionedNoteMutationInput): Promise<Note> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteId)}/restore`, isNote, 'note', { method: 'POST', body: JSON.stringify(input) });
  }

  listBlocks(noteRef: string, options: RequestOptions = {}): Promise<NoteBlock[]> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}/blocks`, (value): value is NoteBlock[] => Array.isArray(value) && value.every(isNoteBlock), 'note blocks', options.signal ? { signal: options.signal } : {});
  }

  getBlock(noteRef: string, blockKey: string, options: RequestOptions = {}): Promise<NoteBlock> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}/blocks/${encodeURIComponent(blockKey)}`, isNoteBlock, 'note block', options.signal ? { signal: options.signal } : {});
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return this.requestValidated(`/search${queryString({ q: params.query, mode: params.mode, limit: params.limit, cursor: params.cursor })}`, isSearchResponse, 'search', params.signal ? { signal: params.signal } : {});
  }

  searchPost(input: SearchRequest, options: SearchPostOptions = {}): Promise<SearchResponse> {
    return this.requestValidated('/search', isSearchResponse, 'search', { method: 'POST', body: JSON.stringify(input), ...(options.signal ? { signal: options.signal } : {}) });
  }

  readNoteContext(documentId: UUID, params: NoteContextParams = {}): Promise<SearchContext> {
    return this.requestValidated(`/search/documents/${encodeURIComponent(documentId)}/context${queryString({ before: params.before ?? 1, after: params.after ?? 1, maxTokens: params.maxTokens ?? 1800 })}`, isSearchContext, 'search context', params.signal ? { signal: params.signal } : {});
  }

  sync(cursor?: string, limit?: number, options: RequestOptions = {}): Promise<SyncPage> {
    return this.requestValidated(`/sync${queryString({ cursor, limit })}`, isSyncPage, 'sync', options.signal ? { signal: options.signal } : {});
  }

  listAttachments(noteRef: string, options: RequestOptions = {}): Promise<Attachment[]> {
    return this.requestValidated(`/notes/${encodeURIComponent(noteRef)}/attachments`, (value): value is Attachment[] => Array.isArray(value) && value.every(isAttachment), 'attachments', options.signal ? { signal: options.signal } : {});
  }

  requestAttachmentUpload(input: { noteId: UUID; fileName: string; mimeType: string; sizeBytes: number }): Promise<{ attachment: Attachment; path: string; token: string }> {
    return this.requestValidated('/attachments/upload-url', (value): value is { attachment: Attachment; path: string; token: string } => isRecord(value) && isAttachment(value.attachment) && isString(value.path) && isString(value.token), 'attachment upload', { method: 'POST', body: JSON.stringify(input) });
  }

  finalizeAttachment(attachmentId: UUID): Promise<Attachment> {
    return this.requestValidated(`/attachments/${encodeURIComponent(attachmentId)}/finalize`, isAttachment, 'attachment', { method: 'POST' });
  }

  async deleteAttachment(attachmentId: UUID): Promise<void> {
    await this.request(`/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
  }

  getAttachmentDownloadUrl(attachmentId: UUID): Promise<{ signedUrl: string; expiresInSeconds: 60 }> {
    return this.requestValidated(`/attachments/${encodeURIComponent(attachmentId)}`, (value): value is { signedUrl: string; expiresInSeconds: 60 } => isRecord(value) && isString(value.signedUrl) && value.expiresInSeconds === 60, 'attachment download', {});
  }

  listTokens(options: RequestOptions = {}): Promise<ApiTokenMetadata[]> {
    return this.requestValidated('/tokens', (value): value is ApiTokenMetadata[] => Array.isArray(value) && value.every(isTokenMetadata), 'tokens', options.signal ? { signal: options.signal } : {});
  }

  createToken(input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
    return this.requestValidated('/tokens', (value): value is CreateApiTokenResult => isRecord(value) && isString(value.token) && isTokenMetadata(value.metadata), 'token', { method: 'POST', body: JSON.stringify(input) });
  }

  async revokeToken(tokenId: UUID): Promise<void> {
    await this.request(`/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
  }

  exportNote(noteRef: string): Promise<Response> {
    return this.binary(`/export/note/${encodeURIComponent(noteRef)}`);
  }

  exportWorkspace(): Promise<Response> {
    return this.binary('/export/workspace');
  }
}
