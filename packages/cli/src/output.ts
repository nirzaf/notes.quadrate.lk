import { access, writeFile } from 'node:fs/promises';
import type { Note, NoteBlock, SearchResult } from '@qnotes/shared';

export function withOneFinalNewline(value: string): string {
  return `${value.replace(/\n+$/g, '')}\n`;
}

export function formatNote(note: Note, raw: boolean): string {
  if (raw) return withOneFinalNewline(note.contentMarkdown);
  const tags = `[${note.tags.join(', ')}]`;
  return withOneFinalNewline([
    '---',
    `id: ${note.id}`,
    `slug: ${note.slug}`,
    `title: ${note.title}`,
    `tags: ${tags}`,
    `version: ${note.version}`,
    `updatedAt: ${note.updatedAt}`,
    '---',
    note.contentMarkdown,
  ].join('\n'));
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.';
  return results.map((result, index) => `${index + 1}. ${result.noteTitle} · ${result.sourceTitle}${result.headingPath ? ` · ${result.headingPath}` : ''}\n   ${result.snippet}`).join('\n');
}

export function formatBlockSummary(blocks: NoteBlock[]): string {
  if (blocks.length === 0) return 'No copyable blocks.';
  const rows = blocks.map((block) => [block.blockKey, block.blockType, block.language ?? '', block.title ?? '']);
  const widths = rows[0]!.map((_, index) => Math.max(['KEY', 'TYPE', 'LANG', 'TITLE'][index]!.length, ...rows.map((row) => row[index]!.length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ');
  return [render(['KEY', 'TYPE', 'LANG', 'TITLE']), render(widths.map((width) => '-'.repeat(width))), ...rows.map(render)].join('\n');
}

export async function writeBinaryFile(path: string, bytes: Uint8Array, force: boolean): Promise<void> {
  if (!force) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite existing file: ${path}. Use --force.`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
    }
  }
  await writeFile(path, bytes);
}
