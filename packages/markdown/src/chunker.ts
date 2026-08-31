import type { MarkdownChunk } from '@qnotes/shared';
import { sha256Hex } from './hash.js';
import { plainTextFromMarkdown } from './parser.js';

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
      paragraph.push(heading[2]?.trim() ?? '');
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushSection();

  const chunks: MarkdownChunk[] = [];
  for (const section of sections) {
    const sectionText = await plainTextFromMarkdown(section.paragraphs.join('\n\n'));
    if (!sectionText) continue;
    const paragraphs = sectionText.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
    for (const paragraphText of paragraphs) {
      for (const content of splitWords(paragraphText, 350)) {
        if (!content) continue;
        const contentHash = await sha256Hex(content);
        chunks.push({
          sourceKey: `section-${chunks.length}-${contentHash.slice(0, 12)}`,
          sourceTitle,
          headingPath: section.headingPath.length ? section.headingPath.join(' > ') : null,
          content,
          position: chunks.length,
          contentHash,
        });
      }
    }
  }
  return chunks;
}
