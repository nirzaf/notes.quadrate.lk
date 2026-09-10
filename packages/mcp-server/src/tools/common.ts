import { DEFAULT_MCP_CONTENT_MAX_BYTES } from '@qnotes/shared';
import type { NoteBlock, SearchContext, SearchRequest, SearchResponse } from '@qnotes/shared';
import type { ContentReadParams } from '@qnotes/api-client';
import type { ZodType } from 'zod';

export interface ReadQNotesClient {
  searchPost(input: SearchRequest, options?: { signal?: AbortSignal }): Promise<SearchResponse>;
  readNoteContext(documentId: string, params?: { before?: number; after?: number; maxTokens?: number; maxBytes?: number; continuation?: string }): Promise<SearchContext>;
  getBlock(noteRef: string, blockKey: string, options?: ContentReadParams): Promise<NoteBlock>;
  listNotebooks(): Promise<{ items: unknown[]; truncated?: boolean }>;
}

export function appendMarkdown(existing: string, addition: string): string {
  const normalizedExisting = existing.replace(/\r\n?/g, '\n');
  const normalizedAddition = addition.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!normalizedAddition) return normalizedExisting;
  if (!normalizedExisting) return `${normalizedAddition}\n`;
  return `${normalizedExisting.replace(/\n+$/, '')}\n\n${normalizedAddition}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MAX_MCP_TOOL_RESPONSE_BYTES = 64 * 1024;

export function boundedMcpContentBytes(value?: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MCP_CONTENT_MAX_BYTES)) {
    throw new Error(`maxBytes must be at most ${DEFAULT_MCP_CONTENT_MAX_BYTES}.`);
  }
  return value ?? DEFAULT_MCP_CONTENT_MAX_BYTES;
}

function serializedToolResultBytes(value: Record<string, unknown>): number {
  const result = {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
  return new TextEncoder().encode(JSON.stringify(result)).byteLength;
}

function boundItems(value: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(value.items)) throw new Error('MCP tool response exceeds the configured wire-byte limit.');
  const items = value.items;
  let low = 0;
  let high = items.length;
  let best = -1;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = { ...value, items: items.slice(0, count), truncated: true };
    if (serializedToolResultBytes(candidate) <= MAX_MCP_TOOL_RESPONSE_BYTES) {
      best = count;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  if (best < 0) throw new Error('MCP tool response exceeds the configured wire-byte limit.');
  return best === items.length ? value : { ...value, items: items.slice(0, best), truncated: true };
}

export function toolResult(value: unknown, schema?: ZodType) {
  const parsed = schema ? schema.parse(value) : value;
  if (!isObject(parsed)) throw new Error('MCP tool output must be an object.');
  const bounded = serializedToolResultBytes(parsed) <= MAX_MCP_TOOL_RESPONSE_BYTES ? parsed : boundItems(parsed);
  const result = {
    content: [{ type: 'text' as const, text: JSON.stringify(bounded) }],
    structuredContent: bounded,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_MCP_TOOL_RESPONSE_BYTES) throw new Error('MCP tool response exceeds the configured wire-byte limit.');
  return result;
}

type ToolHandler = (...args: any[]) => unknown;

const RETRYABLE_CODES = new Set(['RATE_LIMITED', 'RESOURCE_LIMIT_UNAVAILABLE', 'QUERY_EMBEDDING_UNAVAILABLE', 'SEMANTIC_SEARCH_UNAVAILABLE']);
const CONFLICT_CODES = new Set(['NOTE_VERSION_CONFLICT', 'VAULT_VERSION_CONFLICT', 'NOTE_SLUG_CONFLICT', 'NOTEBOOK_NAME_CONFLICT', 'NOTE_DEDUPE_CONFLICT', 'MUTATION_REUSE_CONFLICT', 'VAULT_MUTATION_REUSE', 'VAULT_PROJECT_CONFLICT', 'VAULT_ENVIRONMENT_CONFLICT', 'VAULT_SECRET_CONFLICT']);

function safeDetails(code: string, value: unknown): Record<string, number> | undefined {
  if (!CONFLICT_CODES.has(code) || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const details = value as Record<string, unknown>;
  const safe: Record<string, number> = {};
  for (const key of ['expectedVersion', 'currentVersion', 'resultingVersion']) {
    if (typeof details[key] === 'number' && Number.isSafeInteger(details[key])) safe[key] = details[key] as number;
  }
  return Object.keys(safe).length ? safe : undefined;
}

function errorEnvelope(error: unknown) {
  const candidate = error as { code?: unknown; requestId?: unknown; status?: unknown; details?: unknown };
  const code = typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(candidate.code) ? candidate.code : 'INTERNAL_ERROR';
  const retryable = (typeof candidate?.status === 'number' && [408, 425, 429, 502, 503, 504].includes(candidate.status)) || RETRYABLE_CODES.has(code);
  const details = safeDetails(code, candidate?.details);
  return {
    error: {
      code,
      message: code === 'INTERNAL_ERROR' ? 'The QNotes operation failed.' : 'The QNotes operation could not be completed.',
      retryable,
      requestId: typeof candidate?.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(candidate.requestId) ? candidate.requestId : crypto.randomUUID(),
      ...(details ? { details } : {}),
    },
  };
}

export function safeTool<T extends ToolHandler>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (error) {
      const result = errorEnvelope(error);
      return { ...toolResult(result), isError: true };
    }
  }) as T;
}
