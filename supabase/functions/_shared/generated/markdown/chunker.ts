import type { MarkdownChunk } from '@qnotes/shared';
import { sha256Hex } from './hash.ts';
import { plainTextFromMarkdown } from './parser.ts';

function splitWords(value: string, size: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const result: string[] = [];
  for (let index = 0; index < words.length; index += size) result.push(words.slice(index, index + size).join(' '));
  return result;
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
  for (const section of sections) {
    const paragraphs = [] as string[];
    for (const rawParagraph of section.paragraphs) {
      const text = (await plainTextFromMarkdown(rawParagraph)).trim();
      if (text) paragraphs.push(text);
    }
    let pending: string[] = [];
    let pendingWords = 0;
    const emit = async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const contentHash = await sha256Hex(trimmed);
      chunks.push({
        sourceKey: `section-${chunks.length}-${contentHash.slice(0, 12)}`,
        sourceTitle,
        headingPath: section.headingPath.length ? section.headingPath.join(' > ') : null,
        content: trimmed,
        position: chunks.length,
        contentHash,
      });
    };
    for (const paragraphText of paragraphs) {
      const words = paragraphText.split(/\s+/).filter(Boolean);
      if (words.length > 350) {
        if (pending.length) {
          await emit(pending.join('\n\n'));
          pending = [];
          pendingWords = 0;
        }
        for (const part of splitWords(paragraphText, 350)) await emit(part);
        continue;
      }
      if (pendingWords > 0 && pendingWords + words.length > 350) {
        await emit(pending.join('\n\n'));
        pending = [];
        pendingWords = 0;
      }
      pending.push(paragraphText);
      pendingWords += words.length;
    }
    if (pending.length) await emit(pending.join('\n\n'));
  }
  return chunks;
}
