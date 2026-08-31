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

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export type SearchSourceType =
  | 'note_chunk'
  | 'copy_block'
  | 'code_block'
  | 'attachment_chunk';

export type NoteSyncAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'restored';

export type SyncStatus =
  | 'saved'
  | 'saving'
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
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;
}

export interface CreateNoteInput {
  title: string;
  slug?: string;
  contentMarkdown?: string;
  tags?: string[];
  deviceId: UUID;
  mutationId: UUID;
}

export interface UpdateNoteInput {
  title: string;
  slug: string;
  contentMarkdown: string;
  tags: string[];
  expectedVersion: number;
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
  version: number;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;
}

export interface SyncPage {
  changes: SyncChange[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SearchResult {
  id: UUID;
  noteId: UUID;
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
