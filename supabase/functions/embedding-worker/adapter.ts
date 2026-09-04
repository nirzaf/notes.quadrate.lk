export type SearchDocumentEmbeddingRow = {
  content: string;
  source_title: string | null;
  heading_path: string | null;
};

export type EmbeddingDocument = {
  content: string;
  sourceTitle: string | null;
  headingPath: string | null;
};

export function embeddingDocumentFromRow(row: SearchDocumentEmbeddingRow): EmbeddingDocument {
  return {
    content: row.content,
    sourceTitle: row.source_title,
    headingPath: row.heading_path,
  };
}
