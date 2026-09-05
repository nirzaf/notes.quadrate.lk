import type { NoteBlock, SearchContext, SearchRequest, SearchResponse } from '@qnotes/shared';

export interface ReadQNotesClient {
  searchPost(input: SearchRequest, options?: { signal?: AbortSignal }): Promise<SearchResponse>;
  readNoteContext(documentId: string, params?: { before?: number; after?: number; maxTokens?: number; continuation?: string }): Promise<SearchContext>;
  getBlock(noteRef: string, blockKey: string): Promise<NoteBlock>;
}

export function appendMarkdown(existing: string, addition: string): string {
  const normalizedExisting = existing.replace(/\r\n?/g, '\n');
  const normalizedAddition = addition.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!normalizedAddition) return normalizedExisting;
  if (!normalizedExisting) return `${normalizedAddition}\n`;
  return `${normalizedExisting.replace(/\n+$/, '')}\n\n${normalizedAddition}\n`;
}

export function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}
