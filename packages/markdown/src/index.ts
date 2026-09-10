import type { ParsedMarkdown } from '@qnotes/shared';
import { chunkMarkdown } from './chunker.ts';
import { MarkdownParseError, parseBlocks, plainTextFromMarkdown, sourceTitleFromMarkdown } from './parser.ts';
import { renderMarkdown } from './renderer.ts';

export async function parseMarkdown(markdown: string): Promise<ParsedMarkdown> {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, '\n');
  const parsed = await parseBlocks(normalizedMarkdown);
  const { blocks } = parsed;
  const plainText = await plainTextFromMarkdown(normalizedMarkdown);
  const chunks = await chunkMarkdown(parsed.markdownWithoutBlocks, sourceTitleFromMarkdown(normalizedMarkdown));
  return { normalizedMarkdown, plainText, blocks, chunks };
}

export { MarkdownParseError, renderMarkdown };
export { sha256Hex } from './hash.ts';
export {
  chunkMarkdown,
  chunkText,
  EMBEDDING_INPUT_BYTE_BUDGET,
  EMBEDDING_INPUT_VERSION,
  EMBEDDING_PREFIX_MAX_BYTES,
  EMBEDDING_PROVIDER_TOKEN_LIMIT,
  EMBEDDING_SPECIAL_TOKEN_RESERVE,
  embeddingContentByteBudget,
  embeddingInput,
  embeddingInputByteLength,
  embeddingInputFits,
  embeddingInputHash,
  embeddingPrefix,
  estimateTokenCount,
  splitEmbeddingContent,
  splitTokenAware,
  utf8ByteLength,
} from './chunker.ts';
export { getMarkdownOutline, MarkdownPatchError, patchMarkdownSection } from './outline.ts';
