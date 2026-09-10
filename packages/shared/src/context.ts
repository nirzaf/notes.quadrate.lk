import type { SearchContextSource, SearchSourceType, UUID } from './contracts.ts';

export interface ContextSourceInput {
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
}

export interface BoundedContextContent {
  content: string;
  truncated: boolean;
}

export interface ContextNoteSnapshot {
  version: number;
  updatedAt: string;
}

export const DEFAULT_AGENT_RESPONSE_MAX_BYTES = 64 * 1024;
export const MAX_AGENT_RESPONSE_MAX_BYTES = 64 * 1024;
// A QNotes page is duplicated in the MCP text and structured envelopes.
export const DEFAULT_MCP_CONTENT_MAX_BYTES = Math.floor((MAX_AGENT_RESPONSE_MAX_BYTES - 4 * 1024) / 4);

export interface Utf8ContentSlice {
  content: string;
  startOffset: number;
  endOffset: number;
  totalBytes: number;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function sliceUtf8ByBytes(value: string, startOffset: number, maxBytes: number): Utf8ContentSlice {
  const bytes = new TextEncoder().encode(value);
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > bytes.byteLength) throw new RangeError('startOffset is outside the UTF-8 content.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(bytes.slice(0, startOffset));
  } catch {
    throw new RangeError('startOffset must be on a UTF-8 character boundary.');
  }
  let endOffset = Math.min(bytes.byteLength, startOffset + maxBytes);
  while (endOffset > startOffset) {
    try {
      const content = decoder.decode(bytes.slice(startOffset, endOffset));
      return { content, startOffset, endOffset, totalBytes: bytes.byteLength };
    } catch {
      endOffset -= 1;
    }
  }
  return { content: '', startOffset, endOffset: startOffset, totalBytes: bytes.byteLength };
}

export function utf8LineRange(value: string, lineStart?: number, lineEnd?: number): { startOffset: number; endOffset: number } {
  if (lineStart === undefined && lineEnd === undefined) return { startOffset: 0, endOffset: utf8ByteLength(value) };
  const starts = [0];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    offset += utf8ByteLength(character);
    if (character === '\n') {
      ends.push(offset);
      starts.push(offset);
    }
  }
  if (starts.length > ends.length) ends.push(offset);
  const first = lineStart ?? 1;
  const last = lineEnd ?? ends.length;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || first > starts.length || last > ends.length) {
    throw new RangeError('line range is outside the content.');
  }
  return { startOffset: starts[first - 1]!, endOffset: ends[last - 1]! };
}

export function serializedWireBytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify({ data: value }));
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

export function approximateContextTokens(value: string): number {
  const length = characterCount(value.trim());
  return length === 0 ? 0 : Math.ceil(length / 4);
}

export function contextTokenUsage(value: string): number {
  return value.length === 0 ? 0 : Math.max(1, approximateContextTokens(value));
}

export function boundContextContent(value: string, maxApproximateTokens: number): BoundedContextContent {
  const maxCharacters = Math.max(0, Math.floor(maxApproximateTokens)) * 4;
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return { content: value, truncated: false };
  return { content: characters.slice(0, maxCharacters).join(''), truncated: true };
}

export function boundContextSource(input: ContextSourceInput, maxApproximateTokens: number): SearchContextSource {
  return { ...input, ...boundContextContent(input.content, maxApproximateTokens) };
}

export function takeContextSources(inputs: ContextSourceInput[], maxApproximateTokens: number): SearchContextSource[] {
  const sources: SearchContextSource[] = [];
  let remaining = Math.max(0, Math.floor(maxApproximateTokens));
  for (const input of inputs) {
    if (remaining < 1) break;
    const source = boundContextSource(input, remaining);
    if (!source.content) continue;
    sources.push(source);
    remaining = Math.max(0, remaining - contextTokenUsage(source.content));
  }
  return sources;
}

export function contextNoteChanged(before: ContextNoteSnapshot, after: ContextNoteSnapshot): boolean {
  return before.version !== after.version || before.updatedAt !== after.updatedAt;
}
