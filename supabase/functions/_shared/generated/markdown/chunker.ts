import type { MarkdownChunk } from '@qnotes/shared';
import { sha256Hex } from './hash.ts';
import { plainTextFromMarkdown } from './parser.ts';

export const MARKDOWN_CHUNK_MAX_TOKENS = 350;
export const MARKDOWN_CHUNK_OVERLAP_TOKENS = 40;
export const EMBEDDING_INPUT_VERSION = 'v3';
export const EMBEDDING_PROVIDER_TOKEN_LIMIT = 512;
export const EMBEDDING_SPECIAL_TOKEN_RESERVE = 16;

// Supabase documents a 512-token gte-small limit, but Session.run does not
// expose the provider tokenizer. The byte ceiling is deliberately conservative
// and leaves a special-token reserve; widen it only after measuring that exact
// provider tokenizer.
export const EMBEDDING_INPUT_BYTE_BUDGET = EMBEDDING_PROVIDER_TOKEN_LIMIT - EMBEDDING_SPECIAL_TOKEN_RESERVE;
export const EMBEDDING_PREFIX_MAX_BYTES = 256;
const EMBEDDING_SOURCE_TITLE_MAX_BYTES = 128;

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function normalizeEmbeddingText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/^[ ]+|[ ]+$/g, '') : '';
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let result = '';
  for (const character of value) {
    if (utf8ByteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

export function embeddingPrefix(sourceTitle?: string | null, headingPath?: string | null): string {
  const title = takeUtf8Prefix(normalizeEmbeddingText(sourceTitle), EMBEDDING_SOURCE_TITLE_MAX_BYTES);
  const heading = takeUtf8Prefix(normalizeEmbeddingText(headingPath), EMBEDDING_PREFIX_MAX_BYTES);
  if (!title) return heading;
  if (!heading) return title;
  return `${title}\n\n${takeUtf8Prefix(heading, EMBEDDING_PREFIX_MAX_BYTES - utf8ByteLength(title) - 2)}`;
}

export function embeddingInput(document: { content: string; sourceTitle?: string | null; headingPath?: string | null }): string {
  const prefix = embeddingPrefix(document.sourceTitle, document.headingPath);
  const content = normalizeEmbeddingText(document.content);
  return [prefix, content].filter(Boolean).join('\n\n');
}

export function embeddingInputByteLength(value: string): number {
  return utf8ByteLength(value);
}

export function embeddingContentByteBudget(sourceTitle?: string | null, headingPath?: string | null): number {
  const prefix = embeddingPrefix(sourceTitle, headingPath);
  return Math.max(1, EMBEDDING_INPUT_BYTE_BUDGET - utf8ByteLength(prefix) - (prefix ? 2 : 0));
}

export function embeddingInputFits(value: string): boolean {
  return embeddingInputByteLength(value) <= EMBEDDING_INPUT_BYTE_BUDGET;
}

export async function embeddingInputHash(document: { content: string; sourceTitle?: string | null; headingPath?: string | null }): Promise<string> {
  return sha256Hex(`${EMBEDDING_INPUT_VERSION}\0${embeddingInput(document)}`);
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const result: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (current && currentBytes + characterBytes > maxBytes) {
      result.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) result.push(current);
  return result;
}

/** Split content on lines, then UTF-8 boundaries for one oversized line. */
export function splitEmbeddingContent(value: string, sourceTitle?: string | null, headingPath?: string | null): string[] {
  const normalized = normalizeEmbeddingText(value);
  if (!normalized) return [];
  const maxBytes = embeddingContentByteBudget(sourceTitle, headingPath);
  const lines = normalized.split('\n').filter((line) => line.trim());
  const result: string[] = [];
  let current: string[] = [];
  const emitCurrent = () => {
    if (current.length) result.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (utf8ByteLength(line) > maxBytes) {
      emitCurrent();
      result.push(...splitUtf8(line, maxBytes));
      continue;
    }
    const candidate = current.length ? `${current.join('\n')}\n${line}` : line;
    if (current.length && utf8ByteLength(candidate) > maxBytes) {
      emitCurrent();
      current.push(line);
    } else {
      current.push(line);
    }
  }
  emitCurrent();
  return result;
}

/** A deterministic approximation used because the Edge runtime has no tokenizer dependency. */
export function estimateTokenCount(value: string): number {
  return Math.max(0, Math.ceil(value.trim().length / 4));
}

function splitOversizedToken(value: string, maxTokens: number): string[] {
  const maxCharacters = Math.max(1, maxTokens * 4);
  const result: string[] = [];
  for (let start = 0; start < value.length; start += maxCharacters) result.push(value.slice(start, start + maxCharacters));
  return result;
}

function splitByWords(value: string, maxTokens: number, overlapTokens: number): string[] {
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
      if (end === start && estimateTokenCount(next) > maxTokens) break;
      tokenCount += nextTokens;
      end += 1;
    }
    if (end === start) {
      result.push(...splitOversizedToken(words[start] ?? '', maxTokens));
      start += 1;
      continue;
    }
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

function sentenceParts(value: string): string[] {
  return value.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
}

function overlapTail(value: string, overlapTokens: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  let count = 0;
  let start = words.length;
  while (start > 0 && count < overlapTokens) {
    start -= 1;
    count += estimateTokenCount(words[start] ?? '') + 1;
  }
  return words.slice(start).join(' ');
}

export function splitTokenAware(value: string, maxTokens: number, overlapTokens: number): string[] {
  const normalized = value.trim();
  if (!normalized) return [];
  const sentences = sentenceParts(normalized);
  if (sentences.length < 2) return splitByWords(normalized, maxTokens, overlapTokens);

  const result: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (estimateTokenCount(sentence) > maxTokens) {
      if (current) result.push(current);
      current = '';
      result.push(...splitByWords(sentence, maxTokens, overlapTokens));
      continue;
    }
    const combined = current ? `${current} ${sentence}` : sentence;
    if (current && estimateTokenCount(combined) > maxTokens) {
      result.push(current);
      const overlap = overlapTail(current, overlapTokens);
      const overlapped = overlap ? `${overlap} ${sentence}` : sentence;
      current = estimateTokenCount(overlapped) <= maxTokens ? overlapped : sentence;
    } else {
      current = combined;
    }
  }
  if (current) result.push(current);
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
    let lastEmittedContent = '';
    const emit = async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const headingPath = section.headingPath.length ? section.headingPath.join(' > ') : null;
      const safeParts = embeddingInputFits(embeddingInput({ content: trimmed, sourceTitle, headingPath }))
        ? [trimmed]
        : splitEmbeddingContent(trimmed, sourceTitle, headingPath);
      for (const safeContent of safeParts) {
        const contentHash = await sha256Hex(safeContent);
        const sectionIdentity = section.headingPath.join('\0') || 'root';
        const sectionHash = await sha256Hex(sectionIdentity);
        const baseKey = `section-${sectionHash.slice(0, 16)}-${contentHash.slice(0, 16)}`;
        const occurrence = keyOccurrences.get(baseKey) ?? 0;
        keyOccurrences.set(baseKey, occurrence + 1);
        chunks.push({
          sourceKey: occurrence ? `${baseKey}-${occurrence}` : baseKey,
          sourceTitle,
          headingPath,
          content: safeContent,
          position: chunks.length,
          contentHash,
        });
        lastEmittedContent = safeContent;
      }
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
      const overlap = pending.length === 0 ? overlapTail(lastEmittedContent, MARKDOWN_CHUNK_OVERLAP_TOKENS) : '';
      const overlappedParagraph = overlap ? `${overlap}\n\n${paragraphText}` : paragraphText;
      pending.push(estimateTokenCount(overlappedParagraph) <= MARKDOWN_CHUNK_MAX_TOKENS ? overlappedParagraph : paragraphText);
    }
    if (pending.length) await emit(pending.join('\n\n'));
  }
  return chunks;
}
