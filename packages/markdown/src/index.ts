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
export { chunkMarkdown, chunkText, estimateTokenCount, splitTokenAware } from './chunker.ts';
