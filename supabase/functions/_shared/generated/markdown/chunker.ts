import type { MarkdownChunk } from '@qnotes/shared';
import { sha256Hex } from './hash.ts';
import { plainTextFromMarkdown } from './parser.ts';

export const MARKDOWN_CHUNK_MAX_TOKENS = 350;
export const MARKDOWN_CHUNK_OVERLAP_TOKENS = 40;

/** A deterministic approximation used because the Edge runtime has no tokenizer dependency. */
export function estimateTokenCount(value: string): number {
  return Math.max(0, Math.ceil(value.trim().length / 4));
}

export function splitTokenAware(value: string, maxTokens: number, overlapTokens: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let tokenCount = 0;
    while (end < words.length) {
      const next = words[end] ?? '';
      const nextTokens = estimateTokenCount(next) + (end > start ? 1 : 0);
      if (end > start && tokenCount + nextTokens > maxTokens) break;
      tokenCount += nextTokens;
      end += 1;
    }
    if (end === start) end += 1;
    result.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;

    let overlap = 0;
    let overlapStart = end;
    while (overlapStart > start && overlap < overlapTokens) {
      overlapStart -= 1;
      overlap += estimateTokenCount(words[overlapStart] ?? '') + 1;
    }
    start = Math.max(start + 1, overlapStart);
  }
  return result;
}

export function chunkText(value: string, maxTokens = MARKDOWN_CHUNK_MAX_TOKENS, overlapTokens = MARKDOWN_CHUNK_OVERLAP_TOKENS): string[] {
  return splitTokenAware(value, maxTokens, overlapTokens);
}

export async function chunkMarkdown(markdown: string, sourceTitle: string): Promise<MarkdownChunk[]> {
  const sections: Array<{ headingPath: string[]; paragraphs: string[] }> = [];
  let current = { headingPath: [] as string[], paragraphs: [] as string[] };
  let paragraph: string[] = [];
  const headings: string[] = [];
  const flushParagraph = () => {
    const value = paragraph.join('\n').trim();
    if (value) current.paragraphs.push(value);
    paragraph = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (current.paragraphs.length) sections.push(current);
    current = { headingPath: [...current.headingPath], paragraphs: [] };
  };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushSection();
      const level = heading[1]?.length ?? 1;
      headings.length = level - 1;
      headings[level - 1] = heading[2]?.trim() ?? '';
      current.headingPath = [...headings];
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushSection();

  const chunks: MarkdownChunk[] = [];
  const keyOccurrences = new Map<string, number>();
  for (const section of sections) {
    const paragraphs = [] as string[];
    for (const rawParagraph of section.paragraphs) {
      const text = (await plainTextFromMarkdown(rawParagraph)).trim();
      if (text) paragraphs.push(text);
    }
    let pending: string[] = [];
    const emit = async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const contentHash = await sha256Hex(trimmed);
      const sectionIdentity = section.headingPath.join('\0') || 'root';
      const sectionHash = await sha256Hex(sectionIdentity);
      const baseKey = `section-${sectionHash.slice(0, 16)}-${contentHash.slice(0, 16)}`;
      const occurrence = keyOccurrences.get(baseKey) ?? 0;
      keyOccurrences.set(baseKey, occurrence + 1);
      chunks.push({
        sourceKey: occurrence ? `${baseKey}-${occurrence}` : baseKey,
        sourceTitle,
        headingPath: section.headingPath.length ? section.headingPath.join(' > ') : null,
        content: trimmed,
        position: chunks.length,
        contentHash,
      });
    };
    for (const paragraphText of paragraphs) {
      const paragraphTokens = estimateTokenCount(paragraphText);
      if (paragraphTokens > MARKDOWN_CHUNK_MAX_TOKENS) {
        if (pending.length) {
          await emit(pending.join('\n\n'));
          pending = [];
        }
        for (const part of splitTokenAware(paragraphText, MARKDOWN_CHUNK_MAX_TOKENS, MARKDOWN_CHUNK_OVERLAP_TOKENS)) await emit(part);
        continue;
      }
      const combined = pending.length ? `${pending.join('\n\n')}\n\n${paragraphText}` : paragraphText;
      const combinedTokens = estimateTokenCount(combined);
      if (pending.length && combinedTokens > MARKDOWN_CHUNK_MAX_TOKENS) {
        await emit(pending.join('\n\n'));
        pending = [];
      }
      pending.push(paragraphText);
    }
    if (pending.length) await emit(pending.join('\n\n'));
  }
  return chunks;
}
