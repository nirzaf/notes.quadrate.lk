import MarkdownIt from 'markdown-it';
import type { BlockType, ParsedBlock } from '@qnotes/shared';
import { sha256Hex } from './hash.js';

export class MarkdownParseError extends Error {
  readonly code: 'DUPLICATE_BLOCK_KEY' | 'INVALID_COPY_BLOCK';
  readonly details?: unknown;

  constructor(code: 'DUPLICATE_BLOCK_KEY' | 'INVALID_COPY_BLOCK', message: string, details?: unknown) {
    super(message);
    this.name = 'MarkdownParseError';
    this.code = code;
    this.details = details;
  }
}

const blockTypes = new Set<BlockType>(['copy', 'code', 'prompt', 'command', 'sql', 'json', 'yaml', 'env', 'url', 'quote', 'checklist']);

function normalize(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n');
}

function parseAttributes(raw: string): Record<string, string> {
  let value = raw.trim();
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new MarkdownParseError('INVALID_COPY_BLOCK', 'Copy block attributes must be enclosed in braces.');
    value = value.slice(1, -1).trim();
  } else if (value) {
    throw new MarkdownParseError('INVALID_COPY_BLOCK', 'Copy block attributes must use the {key="value"} form.');
  }
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < value.length) {
    while (value[index] === ' ' || value[index] === '\t') index += 1;
    if (index >= value.length) break;
    const keyStart = index;
    while (/[a-zA-Z]/.test(value[index] ?? '') || /[0-9_-]/.test(value[index] ?? '')) index += 1;
    const key = value.slice(keyStart, index);
    if (!key || !['id', 'title', 'lang', 'type'].includes(key)) throw new MarkdownParseError('INVALID_COPY_BLOCK', `Unsupported copy block attribute: ${key || 'unknown'}.`);
    if (attributes[key] !== undefined) throw new MarkdownParseError('INVALID_COPY_BLOCK', `Duplicate copy block attribute: ${key}.`);
    if (value[index] !== '=') throw new MarkdownParseError('INVALID_COPY_BLOCK', `Copy block attribute ${key} must use an equals sign.`);
    index += 1;
    if (value[index] !== '"') throw new MarkdownParseError('INVALID_COPY_BLOCK', `Copy block attribute ${key} must use double quotes.`);
    index += 1;
    const end = value.indexOf('"', index);
    if (end < 0) throw new MarkdownParseError('INVALID_COPY_BLOCK', `Copy block attribute ${key} is not closed.`);
    attributes[key] = value.slice(index, end);
    index = end + 1;
    if (value[index] && value[index] !== ' ' && value[index] !== '\t') throw new MarkdownParseError('INVALID_COPY_BLOCK', 'Copy block attributes must be separated by spaces.');
  }
  return attributes;
}

function isCopyOpening(line: string): boolean {
  return /^\s*:::copy(?:\s|\{|$)/.test(line);
}

function isCopyClosing(line: string): boolean {
  return /^\s*:::\s*$/.test(line);
}

function isFenceClosing(line: string, fence: string): boolean {
  const trimmed = line.trim();
  const marker = fence[0];
  return marker !== undefined && new RegExp(`^${marker}{${fence.length},}$`).test(trimmed);
}

function codeKeyInput(language: string, content: string, occurrence: number): string {
  return `code\0${language}\0${content}\0${occurrence}`;
}

function contentHashInput(blockType: BlockType, language: string | null, content: string): string {
  return `${blockType}\0${language ?? ''}\0${content}`;
}

export type ParsedSource = {
  blocks: ParsedBlock[];
  markdownWithoutNamedBlocks: string;
};

export async function parseBlocks(markdown: string): Promise<ParsedSource> {
  const normalized = normalize(markdown);
  const lines = normalized.split('\n');
  const blocks: ParsedBlock[] = [];
  const seenExplicit = new Set<string>();
  const occurrences = new Map<string, number>();
  const keptLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (isCopyOpening(line)) {
      const rawAttributes = line.replace(/^\s*:::copy/, '');
      const attributes = parseAttributes(rawAttributes);
      const blockKey = attributes.id;
      if (!blockKey || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(blockKey)) throw new MarkdownParseError('INVALID_COPY_BLOCK', 'A named copy block requires a valid lowercase id.');
      if (seenExplicit.has(blockKey)) throw new MarkdownParseError('DUPLICATE_BLOCK_KEY', `Duplicate copy block id: ${blockKey}.`, { blockKey });
      seenExplicit.add(blockKey);
      const contentLines: string[] = [];
      let closeIndex = index + 1;
      for (; closeIndex < lines.length; closeIndex += 1) {
        const nestedLine = lines[closeIndex] ?? '';
        if (isCopyOpening(nestedLine)) throw new MarkdownParseError('INVALID_COPY_BLOCK', 'Nested copy blocks are not supported.');
        if (isCopyClosing(nestedLine)) break;
        contentLines.push(nestedLine);
      }
      if (closeIndex >= lines.length) throw new MarkdownParseError('INVALID_COPY_BLOCK', `Copy block ${blockKey} is not closed.`);
      let content = contentLines.join('\n');
      if (content.endsWith('\n')) content = content.slice(0, -1);
      const language = attributes.lang ?? null;
      const blockType = attributes.type ?? 'copy';
      if (!blockTypes.has(blockType as BlockType)) throw new MarkdownParseError('INVALID_COPY_BLOCK', `Invalid copy block type: ${blockType}.`);
      blocks.push({
        blockKey,
        blockType: blockType as BlockType,
        title: attributes.title ?? blockKey,
        language: language || null,
        content,
        position: blocks.length,
        copyable: true,
        explicit: true,
        contentHash: await sha256Hex(contentHashInput(blockType as BlockType, language || null, content)),
      });
      keptLines.push('');
      index = closeIndex;
      continue;
    }

    const fenceStart = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceStart) {
      const fence = fenceStart[1] ?? '```';
      const info = (fenceStart[2] ?? '').trim();
      const language = info.split(/\s+/)[0] ?? '';
      const contentLines: string[] = [];
      let closeIndex = index + 1;
      for (; closeIndex < lines.length; closeIndex += 1) {
        if (isFenceClosing(lines[closeIndex] ?? '', fence)) break;
        contentLines.push(lines[closeIndex] ?? '');
      }
      if (closeIndex >= lines.length) throw new MarkdownParseError('INVALID_COPY_BLOCK', 'Fenced code block is not closed.');
      let content = contentLines.join('\n');
      if (content.endsWith('\n')) content = content.slice(0, -1);
      const occurrenceInput = `${language}\0${content}`;
      const occurrence = occurrences.get(occurrenceInput) ?? 0;
      occurrences.set(occurrenceInput, occurrence + 1);
      blocks.push({
        blockKey: `auto-${(await sha256Hex(codeKeyInput(language, content, occurrence))).slice(0, 16)}`,
        blockType: 'code',
        title: null,
        language: language || null,
        content,
        position: blocks.length,
        copyable: true,
        explicit: false,
        contentHash: await sha256Hex(contentHashInput('code', language || null, content)),
      });
      keptLines.push(line, ...contentLines, lines[closeIndex] ?? fence);
      index = closeIndex;
      continue;
    }

    keptLines.push(line);
  }

  return { blocks, markdownWithoutNamedBlocks: keptLines.join('\n') };
}

export function sourceTitleFromMarkdown(markdown: string): string {
  const heading = normalize(markdown).match(/^\s*#\s+(.+?)\s*#*\s*$/m);
  return heading?.[1]?.trim() ?? '';
}

export async function plainTextFromMarkdown(markdown: string): Promise<string> {
  const normalized = normalize(markdown)
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/^\s*:::copy(?:\s|\{|$).*$/gm, '')
    .replace(/^\s*:::\s*$/gm, '');
  const rendered = new MarkdownIt({ html: false, linkify: false, typographer: false }).render(normalized);
  return rendered
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
