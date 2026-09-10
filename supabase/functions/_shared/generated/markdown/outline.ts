import type { NoteOutlineBlock, NoteOutlineSection, ParsedBlock } from '@qnotes/shared';
import { parseBlocks } from './parser.ts';
import { sha256Hex } from './hash.ts';

interface Heading {
  index: number;
  level: number;
  heading: string;
  headingPath: string[];
  occurrence: number;
}

interface SectionRange extends NoteOutlineSection {
  bodyStart: number;
  bodyEnd: number;
}

export class MarkdownPatchError extends Error {
  readonly code: 'SECTION_NOT_FOUND' | 'SECTION_AMBIGUOUS' | 'SECTION_HASH_MISMATCH';

  constructor(code: MarkdownPatchError['code'], message: string) {
    super(message);
    this.name = 'MarkdownPatchError';
    this.code = code;
  }
}

function headingMatch(line: string): RegExpMatchArray | null {
  return line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
}

function isCopyOpening(line: string): boolean {
  return /^\s*:::copy(?:\s|\{|$)/.test(line);
}

function isCopyClosing(line: string): boolean {
  return /^\s*:::\s*$/.test(line);
}

function isFenceClosing(line: string, fence: string): boolean {
  const marker = fence[0];
  return marker !== undefined && new RegExp(`^${marker}{${fence.length},}$`).test(line.trim());
}

function collectHeadings(lines: string[]): Heading[] {
  const headings: string[] = [];
  const occurrences = new Map<string, number>();
  const result: Heading[] = [];
  let fence: string | undefined;
  let copyBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (copyBlock) {
      if (isCopyClosing(line)) copyBlock = false;
      continue;
    }
    if (isCopyOpening(line)) {
      copyBlock = true;
      continue;
    }
    if (fence) {
      if (isFenceClosing(line, fence)) fence = undefined;
      continue;
    }
    const fenceStart = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceStart) {
      fence = fenceStart[1];
      continue;
    }
    const match = headingMatch(line);
    if (!match) continue;
    const level = match[1]?.length ?? 1;
    const heading = match[2]?.trim() ?? '';
    headings.length = level - 1;
    headings[level - 1] = heading;
    const headingPath = [...headings];
    const identity = `${level}\0${headingPath.join('\0')}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    result.push({ index, level, heading, headingPath, occurrence });
  }
  return result;
}

async function sectionId(heading: Heading): Promise<string> {
  const identity = `qnotes-section-v1\0${heading.level}\0${heading.headingPath.join('\0')}\0${heading.occurrence}`;
  return `section-${(await sha256Hex(identity)).slice(0, 24)}`;
}

async function sectionRanges(markdown: string): Promise<{ normalized: string; lines: string[]; sections: SectionRange[]; blocks: ParsedBlock[] }> {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const headings = collectHeadings(lines);
  const sections: SectionRange[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const nextSection = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const fullEnd = nextSection?.index === undefined ? lines.length - 1 : nextSection.index - 1;
    const firstChild = headings.slice(index + 1).find((candidate) => candidate.index <= fullEnd && candidate.level > heading.level);
    const bodyStart = heading.index + 1;
    const bodyEnd = firstChild ? firstChild.index - 1 : fullEnd;
    const content = bodyStart <= bodyEnd ? lines.slice(bodyStart, bodyEnd + 1).join('\n') : '';
    const childCount = headings.slice(index + 1).filter((candidate) => candidate.index <= fullEnd && candidate.level > heading.level).length;
    sections.push({
      sectionId: await sectionId(heading),
      level: heading.level,
      heading: heading.heading,
      headingPath: heading.headingPath,
      startLine: heading.index + 1,
      endLine: fullEnd + 1,
      contentStartLine: bodyStart <= bodyEnd ? bodyStart + 1 : bodyStart + 1,
      contentEndLine: bodyStart <= bodyEnd ? bodyEnd + 1 : bodyStart,
      contentHash: await sha256Hex(content),
      childCount,
      bodyStart,
      bodyEnd,
    });
  }

  const parsed = await parseBlocks(normalized);
  return { normalized, lines, sections, blocks: parsed.blocks };
}

function outlineBlocks(blocks: ParsedBlock[]): NoteOutlineBlock[] {
  return blocks.map(({ blockKey, blockType, position, contentHash }) => ({ blockKey, blockType, position, contentHash }));
}

export async function getMarkdownOutline(markdown: string): Promise<{ markdownHash: string; sections: NoteOutlineSection[]; blocks: NoteOutlineBlock[] }> {
  const parsed = await sectionRanges(markdown);
  return {
    markdownHash: await sha256Hex(parsed.normalized),
    sections: parsed.sections.map(({ bodyStart: _bodyStart, bodyEnd: _bodyEnd, ...section }) => section),
    blocks: outlineBlocks(parsed.blocks),
  };
}

export async function patchMarkdownSection(markdown: string, sectionIdValue: string, expectedContentHash: string, replacementMarkdown: string): Promise<string> {
  const parsed = await sectionRanges(markdown);
  const matches = parsed.sections.filter((section) => section.sectionId === sectionIdValue);
  if (!matches.length) throw new MarkdownPatchError('SECTION_NOT_FOUND', 'The requested note section was not found.');
  if (matches.length !== 1) throw new MarkdownPatchError('SECTION_AMBIGUOUS', 'The requested note section is ambiguous.');
  const section = matches[0]!;
  if (section.contentHash !== expectedContentHash.toLowerCase()) throw new MarkdownPatchError('SECTION_HASH_MISMATCH', 'The requested note section changed.');

  const replacement = replacementMarkdown.replace(/\r\n?/g, '\n');
  const originalLines = parsed.lines.slice(section.bodyStart, section.bodyEnd + 1);
  let leadingBlankLines = 0;
  while (leadingBlankLines < originalLines.length && originalLines[leadingBlankLines]?.trim() === '') leadingBlankLines += 1;
  let trailingBlankLines = 0;
  while (trailingBlankLines < originalLines.length - leadingBlankLines && originalLines[originalLines.length - trailingBlankLines - 1]?.trim() === '') trailingBlankLines += 1;
  const replacementCore = replacement ? replacement.split('\n') : [];
  const replacementLines = [
    ...(replacementCore[0] === '' ? [] : Array.from({ length: leadingBlankLines }, () => '')),
    ...replacementCore,
    ...(replacementCore.at(-1) === '' ? [] : Array.from({ length: trailingBlankLines }, () => '')),
  ];
  const nextLines = [
    ...parsed.lines.slice(0, section.bodyStart),
    ...replacementLines,
    ...parsed.lines.slice(section.bodyEnd + 1),
  ];
  let result = nextLines.join('\n');
  if (parsed.normalized.endsWith('\n') && !result.endsWith('\n')) result += '\n';
  return result;
}
