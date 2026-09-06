import { createClient } from '@supabase/supabase-js';
import type { Attachment, Note, NoteBlock, NoteSummary, Notebook, SearchResult } from '@qnotes/shared';
import { ApiError } from './errors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
export const appDbClient = serviceClient.schema('notesdb');

export function noteFromRow(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    contentMarkdown: String(row.content_markdown ?? ''),
    contentPlain: String(row.content_plain ?? ''),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    notebookId: row.notebook_id ? String(row.notebook_id) : row.notebookId ? String(row.notebookId) : null,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}

export function notebookFromRow(row: Record<string, unknown>): Notebook {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at ?? row.createdAt),
    updatedAt: String(row.updated_at ?? row.updatedAt),
  };
}

export function summaryFromRow(row: Record<string, unknown>): NoteSummary {
  const note = noteFromRow(row);
  return { ...note, excerpt: note.contentPlain.slice(0, 180) };
}

export function blockFromRow(row: Record<string, unknown>): NoteBlock {
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    blockKey: String(row.block_key),
    blockType: String(row.block_type) as NoteBlock['blockType'],
    title: row.title ? String(row.title) : null,
    language: row.language ? String(row.language) : null,
    content: String(row.content ?? ''),
    position: Number(row.position),
    copyable: true,
    contentHash: String(row.content_hash),
  };
}

export function attachmentFromRow(row: Record<string, unknown>): Attachment {
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    originalFileName: String(row.original_file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    status: String(row.extraction_status) as Attachment['status'],
    extractionError: row.extraction_error ? String(row.extraction_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function searchResultFromRow(row: Record<string, unknown>): SearchResult {
  const sourceType = String(row.source_type) as SearchResult['sourceType'];
  const blockKey = row.block_key ? String(row.block_key) : sourceType === 'copy_block' || sourceType === 'code_block' ? String(row.source_key) : null;
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    noteSlug: String(row.note_slug),
    noteTitle: String(row.note_title),
    sourceType,
    sourceId: row.source_id ? String(row.source_id) : null,
    sourceKey: String(row.source_key),
    sourceTitle: String(row.source_title),
    headingPath: row.heading_path ? String(row.heading_path) : null,
    snippet: String(row.snippet ?? ''),
    score: Number(row.score ?? 0),
    keywordRank: row.keyword_rank === null || row.keyword_rank === undefined ? null : Number(row.keyword_rank),
    semanticRank: row.semantic_rank === null || row.semantic_rank === undefined ? null : Number(row.semantic_rank),
    copyable: sourceType === 'copy_block' || sourceType === 'code_block',
    blockKey,
    language: row.language ? String(row.language) : null,
    attachmentId: row.attachment_id ? String(row.attachment_id) : null,
  };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assertSupabase<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new ApiError(500, 'INTERNAL_ERROR', 'The database request failed.');
  return result.data;
}

export function encodeCursor(value: { updatedAt: string; id: string }): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeCursor(value: string): { updatedAt: string; id: string } {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { updatedAt?: unknown }).updatedAt !== 'string' || typeof (parsed as { id?: unknown }).id !== 'string') throw new Error('invalid');
    return parsed as { updatedAt: string; id: string };
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'cursor must be a valid opaque cursor.');
  }
}

export interface SearchCursor {
  version: 1;
  fingerprint: string;
  offset: number;
}

export function encodeSearchCursor(value: Omit<SearchCursor, 'version'>): string {
  return btoa(JSON.stringify({ version: 1, ...value })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeSearchCursor(value: string): SearchCursor {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
    const cursor = parsed as Partial<SearchCursor>;
    const offset = cursor.offset;
    if (cursor.version !== 1 || typeof cursor.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid');
    return { version: 1, fingerprint: cursor.fingerprint, offset };
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'cursor must be a valid opaque search cursor.');
  }
}
