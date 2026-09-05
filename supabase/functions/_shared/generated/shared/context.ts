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
