import type {
  ApiTokenMetadata,
  Attachment,
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
  SyncPage,
  UpdateNoteInput,
  UUID,
  VersionedNoteMutationInput,
} from '@qnotes/shared';
import { QNotesHttpError } from './http-error.ts';

export type CreateNoteOutcome = 'created' | 'idempotent' | 'deduplicated';

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
  tag?: string;
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
}

type Success<T> = { data: T };

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
    return this.request(`/notes${queryString({ cursor: params.cursor, limit: params.limit, includeDeleted: params.includeDeleted, tag: params.tag })}`);
  }

  listNotebooks(): Promise<{ items: Notebook[] }> {
    return this.request('/notebooks');
  }

  createNotebook(input: CreateNotebookInput): Promise<Notebook> {
    return this.request('/notebooks', { method: 'POST', body: JSON.stringify(input) });
  }

  getNote(noteRef: string): Promise<Note> {
    return this.request(`/notes/${encodeURIComponent(noteRef)}`);
  }

  createNote(input: CreateNoteInput): Promise<Note> {
    return this.request('/notes', { method: 'POST', body: JSON.stringify(input) });
  }

  async createNoteDetailed(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.requestWithResponse<Note>('/notes', { method: 'POST', body: JSON.stringify(input) });
    const outcome = result.response.headers.get('x-qnotes-create-outcome');
    if (outcome === 'created' || outcome === 'idempotent' || outcome === 'deduplicated') return { note: result.data, outcome };
    return { note: result.data, outcome: result.response.status === 201 ? 'created' : 'idempotent' };
  }

  updateNote(noteId: UUID, input: UpdateNoteInput): Promise<Note> {
    return this.request(`/notes/${encodeURIComponent(noteId)}`, { method: 'PATCH', body: JSON.stringify(input) });
  }

  moveNoteToNotebook(noteId: UUID, input: { notebookId: UUID | null; expectedVersion: number; deviceId: UUID; mutationId: UUID }): Promise<Note> {
    return this.request(`/notes/${encodeURIComponent(noteId)}/notebook`, { method: 'PATCH', body: JSON.stringify(input) });
  }

  deleteNote(noteId: UUID, input: VersionedNoteMutationInput): Promise<Note> {
    return this.request(`/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE', body: JSON.stringify(input) });
  }

  restoreNote(noteId: UUID, input: VersionedNoteMutationInput): Promise<Note> {
    return this.request(`/notes/${encodeURIComponent(noteId)}/restore`, { method: 'POST', body: JSON.stringify(input) });
  }

  listBlocks(noteRef: string): Promise<NoteBlock[]> {
    return this.request(`/notes/${encodeURIComponent(noteRef)}/blocks`);
  }

  getBlock(noteRef: string, blockKey: string): Promise<NoteBlock> {
    return this.request(`/notes/${encodeURIComponent(noteRef)}/blocks/${encodeURIComponent(blockKey)}`);
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return this.request(`/search${queryString({ q: params.query, mode: params.mode, limit: params.limit, cursor: params.cursor })}`, params.signal ? { signal: params.signal } : {});
  }

  searchPost(input: SearchRequest, options: SearchPostOptions = {}): Promise<SearchResponse> {
    return this.request('/search', { method: 'POST', body: JSON.stringify(input), ...(options.signal ? { signal: options.signal } : {}) });
  }

  readNoteContext(documentId: UUID, params: NoteContextParams = {}): Promise<SearchContext> {
    return this.request(`/search/documents/${encodeURIComponent(documentId)}/context${queryString({ before: params.before ?? 1, after: params.after ?? 1, maxTokens: params.maxTokens ?? 1800 })}`);
  }

  sync(cursor?: string, limit?: number): Promise<SyncPage> {
    return this.request(`/sync${queryString({ cursor, limit })}`);
  }

  listAttachments(noteRef: string): Promise<Attachment[]> {
    return this.request(`/notes/${encodeURIComponent(noteRef)}/attachments`);
  }

  requestAttachmentUpload(input: { noteId: UUID; fileName: string; mimeType: string; sizeBytes: number }): Promise<{ attachment: Attachment; path: string; token: string }> {
    return this.request('/attachments/upload-url', { method: 'POST', body: JSON.stringify(input) });
  }

  finalizeAttachment(attachmentId: UUID): Promise<Attachment> {
    return this.request(`/attachments/${encodeURIComponent(attachmentId)}/finalize`, { method: 'POST' });
  }

  async deleteAttachment(attachmentId: UUID): Promise<void> {
    await this.request(`/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
  }

  getAttachmentDownloadUrl(attachmentId: UUID): Promise<{ signedUrl: string; expiresInSeconds: 60 }> {
    return this.request(`/attachments/${encodeURIComponent(attachmentId)}`);
  }

  listTokens(): Promise<ApiTokenMetadata[]> {
    return this.request('/tokens');
  }

  createToken(input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
    return this.request('/tokens', { method: 'POST', body: JSON.stringify(input) });
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
