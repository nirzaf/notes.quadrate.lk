import type { ParsedMarkdown } from '@qnotes/shared';
import { chunkMarkdown } from './chunker.js';
import { MarkdownParseError, parseBlocks, plainTextFromMarkdown, sourceTitleFromMarkdown } from './parser.js';
import { renderMarkdown } from './renderer.js';

export async function parseMarkdown(markdown: string): Promise<ParsedMarkdown> {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, '\n');
  const { blocks } = await parseBlocks(normalizedMarkdown);
  const plainText = await plainTextFromMarkdown(normalizedMarkdown);
  const chunks = await chunkMarkdown(normalizedMarkdown, sourceTitleFromMarkdown(normalizedMarkdown));
  return { normalizedMarkdown, plainText, blocks, chunks };
}

export { MarkdownParseError, renderMarkdown };
export { sha256Hex } from './hash.js';
export { chunkMarkdown } from './chunker.js';
