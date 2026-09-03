import type { NoteBlock, SearchContext, SearchRequest, SearchResponse } from '@qnotes/shared';

export interface ReadQNotesClient {
  searchPost(input: SearchRequest): Promise<SearchResponse>;
  readNoteContext(documentId: string, params?: { before?: number; after?: number; maxTokens?: number }): Promise<SearchContext>;
  getBlock(noteRef: string, blockKey: string): Promise<NoteBlock>;
}

export function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}
