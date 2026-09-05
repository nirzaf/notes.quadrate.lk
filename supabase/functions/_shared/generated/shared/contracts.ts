export type UUID = string;
export type ISODateTime = string;

export type BlockType =
  | 'copy'
  | 'code'
  | 'prompt'
  | 'command'
  | 'sql'
  | 'json'
  | 'yaml'
  | 'env'
  | 'url'
  | 'quote'
  | 'checklist';

export type SearchMode = 'auto' | 'keyword' | 'semantic' | 'hybrid';
export type ResolvedSearchMode = Exclude<SearchMode, 'auto'>;

export type SearchSourceType =
  | 'note_metadata'
  | 'note_chunk'
  | 'copy_block'
  | 'code_block'
  | 'attachment_chunk';

export interface SearchFilters {
  notebookIds?: UUID[];
  tags?: string[];
  sourceTypes?: SearchSourceType[];
  languages?: string[];
  updatedAfter?: ISODateTime;
  unfiled?: boolean;
}

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  limit: number;
  maxPerNote: number;
  filters: SearchFilters;
  minimumRelativeScore?: number;
  /** @deprecated Use minimumRelativeScore. This remains accepted for clients of the v1 API. */
  minimumConfidence?: number;
  cursor?: string;
}

export type NoteSyncAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'restored';

export type SyncStatus =
  | 'saved'
  | 'pending'
  | 'saving'
  | 'draft'
  | 'validation-error'
  | 'network-error'
  | 'storage-error'
  | 'remote-change'
  | 'syncing'
  | 'offline'
  | 'conflict'
  | 'error';

export type AttachmentStatus =
  | 'pending_upload'
  | 'uploaded'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'unsupported'
  | 'deleted';

export type ApiTokenScope =
  | 'notes:read'
  | 'notes:write'
  | 'search:read'
  | 'attachments:read'
  | 'attachments:write';

export interface Note {
  id: UUID;
  slug: string;
  title: string;
  contentMarkdown: string;
  contentPlain: string;
  tags: string[];
  notebookId: UUID | null;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;
}

export interface NoteSummary {
  id: UUID;
  slug: string;
  title: string;
  excerpt: string;
  tags: string[];
  notebookId: UUID | null;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;
}

export interface ListNotesQuery {
  cursor?: string;
  limit: number;
  includeDeleted: boolean;
  deletedOnly: boolean;
  notebookId?: UUID;
  unfiled: boolean;
  tag?: string;
}

export interface Notebook {
  id: UUID;
  name: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CreateNotebookInput {
  name: string;
}

export interface MoveNoteToNotebookInput extends VersionedNoteMutationInput {
  notebookId: UUID | null;
}

export interface CreateNoteInput {
  title: string;
  slug?: string;
  contentMarkdown?: string;
  tags?: string[];
  notebookId?: UUID | null;
  dedupeKey?: string;
  deviceId: UUID;
  mutationId: UUID;
}

export interface UpdateNoteInput {
  title: string;
  slug: string;
  contentMarkdown: string;
  tags?: string[];
  expectedVersion: number;
  deviceId: UUID;
  mutationId: UUID;
}

export interface AppendNoteInput {
  contentMarkdown: string;
  expectedVersion?: number;
  deviceId: UUID;
  mutationId: UUID;
}

export interface VersionedNoteMutationInput {
  expectedVersion: number;
  deviceId: UUID;
  mutationId: UUID;
}

export interface NoteBlock {
  id: UUID;
  noteId: UUID;
  blockKey: string;
  blockType: BlockType;
  title: string | null;
  language: string | null;
  content: string;
  position: number;
  copyable: true;
  contentHash: string;
}

export interface ParsedBlock {
  blockKey: string;
  blockType: BlockType;
  title: string | null;
  language: string | null;
  content: string;
  position: number;
  copyable: true;
  explicit: boolean;
  contentHash: string;
}

export interface MarkdownChunk {
  sourceKey: string;
  sourceTitle: string;
  headingPath: string | null;
  content: string;
  position: number;
  contentHash: string;
}

export interface ParsedMarkdown {
  normalizedMarkdown: string;
  plainText: string;
  blocks: ParsedBlock[];
  chunks: MarkdownChunk[];
}

export interface RenderedMarkdown {
  html: string;
  plainText: string;
  blocks: ParsedBlock[];
}

export interface RealtimeNoteEvent {
  schemaVersion: 1;
  entity: 'note';
  action: NoteSyncAction;
  noteId: UUID;
  version: number;
  updatedAt: ISODateTime;
  sourceDeviceId: UUID;
  mutationId: UUID;
}

export interface SyncChange {
  noteId: UUID;
  slug: string;
  title: string;
  tags: string[];
  notebookId: UUID | null;
  version: number;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;
}

export interface SyncPage {
  changes: SyncChange[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SearchContextSource {
  documentId: UUID;
  noteId: UUID;
  noteVersion: number;
  sourceType: SearchSourceType;
  sourceId: UUID | null;
  sourceKey: string;
  sourceTitle: string;
  headingPath: string | null;
  attachmentId: UUID | null;
  pageNumber: number | null;
  content: string;
  sourceHash: string;
  truncated: boolean;
}

export interface SearchContextTokenBudget {
  max: number;
  used: number;
  unit: 'approximate_tokens';
}

export interface SearchContext {
  noteId: UUID;
  noteVersion: number;
  documentId: UUID;
  uri: string;
  title: string;
  headingPath: string | null;
  content: string;
  previous: string[];
  next: string[];
  updatedAt: ISODateTime;
  sourceType: SearchSourceType;
  sourceId?: UUID | null;
  sourceKey?: string;
  sourceTitle?: string;
  attachmentId?: UUID | null;
  pageNumber?: number | null;
  sourceHash?: string;
  truncated?: boolean;
  tokenBudget?: SearchContextTokenBudget;
  previousSources?: SearchContextSource[];
  nextSources?: SearchContextSource[];
}
export interface SearchResult {
  id: UUID;
  documentId?: UUID;
  noteId: UUID;
  noteVersion?: number;
  noteSlug: string;
  noteTitle: string;
  sourceType: SearchSourceType;
  sourceId: UUID | null;
  sourceKey: string;
  sourceTitle: string;
  headingPath: string | null;
  snippet: string;
  score: number;
  keywordRank: number | null;
  semanticRank: number | null;
  copyable: boolean;
  blockKey: string | null;
  language: string | null;
  attachmentId: UUID | null;
  uri?: string;
  tags?: string[];
  notebookId?: UUID | null;
  updatedAt?: ISODateTime;
  matchReasons?: string[];
  scores?: {
    hybrid: number;
    keywordRank: number | null;
    semanticRank: number | null;
  };
}

export interface SearchIndexMetadata {
  model: string;
  pendingDocuments: number;
  failedDocuments: number;
  oldestPendingAgeSeconds: number | null;
  fresh: boolean;
}

export interface SearchTiming {
  embeddingMs: number;
  retrievalMs: number;
  totalMs: number;
}

export type SearchDegradedReason = 'QUERY_EMBEDDING_UNAVAILABLE' | 'SEMANTIC_SEARCH_UNAVAILABLE' | 'LOCAL_FALLBACK';

export interface SearchResponseMetadata {
  queryId: UUID;
  modeUsed: ResolvedSearchMode;
  degraded: boolean;
  degradedReason?: SearchDegradedReason;
  timing: SearchTiming;
}

export interface SearchResponse extends SearchResponseMetadata {
  items: SearchResult[];
  index?: SearchIndexMetadata;
  nextCursor?: string | null;
}
export interface Attachment {
  id: UUID;
  noteId: UUID;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  extractionError: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ApiTokenMetadata {
  id: UUID;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  expiresAt: ISODateTime | null;
  lastUsedAt: ISODateTime | null;
  revokedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: ApiTokenScope[];
  expiresAt: ISODateTime | null;
}

export interface CreateApiTokenResult {
  token: string;
  metadata: ApiTokenMetadata;
}

export interface ApiSuccess<T> {
  data: T;
}

export interface ApiFailure {
  error: {
    code: import('./errors.ts').QNotesErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
