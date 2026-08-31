import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Note, NoteBlock } from '@qnotes/shared';
import { QNotesClient as Client, type QNotesClient } from '@qnotes/api-client';
import { formatBlockSummary, formatNote, formatSearchResults, withOneFinalNewline, writeBinaryFile } from './output.js';

export class CliUsageError extends Error {
  readonly exitCode = 2;
}

export interface CommandIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(message?: string): never {
  throw new CliUsageError(message ?? 'Invalid command usage.');
}

function help(): string {
  return `qnotes — Markdown notes over the Quadrate API

Commands:
  qnotes search "query" [--semantic|--hybrid] [--json]
  qnotes get <note-id-or-slug> [--raw]
  qnotes blocks <note-id-or-slug>
  qnotes block get <note-id-or-slug> <block-key>
  qnotes notebooks
  qnotes notebook create "Notebook name"
  qnotes notebook move <note-id-or-slug> <notebook-id|unfiled>
  qnotes create --title "Title" --file note.md [--notebook <id>]
  qnotes capture "Text to remember"
  qnotes append <note-id-or-slug> "Text to append"
  qnotes export <note-id-or-slug> [--output note.md] [--force]
  qnotes export --workspace --output backup.zip [--force]

Environment:
  QNOTES_URL    API function root
  QNOTES_TOKEN  Scoped qnt_ token`;
}

export function createClientFromEnvironment(): QNotesClient {
  const baseUrl = process.env.QNOTES_URL;
  const token = process.env.QNOTES_TOKEN;
  if (!baseUrl || !token) throw new Error('QNOTES_URL and QNOTES_TOKEN are required.');
  return new Client({ baseUrl, getAccessToken: () => token });
}

function notePayload(note: Note, contentMarkdown: string) {
  return {
    title: note.title,
    slug: note.slug,
    contentMarkdown,
    tags: note.tags,
    expectedVersion: note.version,
    deviceId: randomUUID(),
    mutationId: randomUUID(),
  };
}

function textFromArgs(args: string[]): string {
  return args.filter((value) => !value.startsWith('--')).join(' ').trim();
}

async function moveToNotebook(client: QNotesClient, note: Note, notebookId: string): Promise<Note> {
  return client.moveNoteToNotebook(note.id, { notebookId: notebookId === 'unfiled' ? null : notebookId, expectedVersion: note.version, deviceId: randomUUID(), mutationId: randomUUID() });
}

export async function runCommand(args: string[], io: CommandIo, api?: QNotesClient): Promise<void> {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    io.stdout(`${help()}\n`);
    return;
  }
  if (command === 'search') {
    const query = textFromArgs(args.slice(1));
    if (!query) usage('Usage: qnotes search "query"');
    const client = api ?? createClientFromEnvironment();
    const mode = args.includes('--semantic') ? 'semantic' : args.includes('--hybrid') ? 'hybrid' : 'keyword';
    const results = await client.search({ query, mode });
    io.stdout(`${args.includes('--json') ? JSON.stringify(results, null, 2) : formatSearchResults(results)}\n`);
    return;
  }

  if (command === 'get') {
    const reference = args[1];
    if (!reference || reference.startsWith('--')) usage('Usage: qnotes get <note-id-or-slug> [--raw]');
    const client = api ?? createClientFromEnvironment();
    io.stdout(formatNote(await client.getNote(reference), args.includes('--raw')));
    return;
  }

  if (command === 'notebooks') {
    const client = api ?? createClientFromEnvironment();
    io.stdout(`${JSON.stringify(await client.listNotebooks(), null, 2)}\n`);
    return;
  }

  if (command === 'notebook' && args[1] === 'create') {
    const name = textFromArgs(args.slice(2));
    if (!name) usage('Usage: qnotes notebook create "Notebook name"');
    const client = api ?? createClientFromEnvironment();
    io.stdout(`${JSON.stringify(await client.createNotebook({ name }), null, 2)}\n`);
    return;
  }

  if (command === 'notebook' && args[1] === 'move') {
    const reference = args[2];
    const notebookId = args[3];
    if (!reference || !notebookId || reference.startsWith('--') || notebookId.startsWith('--')) usage('Usage: qnotes notebook move <note-id-or-slug> <notebook-id|unfiled>');
    const client = api ?? createClientFromEnvironment();
    io.stdout(`${JSON.stringify(await moveToNotebook(client, await client.getNote(reference), notebookId), null, 2)}\n`);
    return;
  }

  if (command === 'blocks') {
    const reference = args[1];
    if (!reference || reference.startsWith('--')) usage('Usage: qnotes blocks <note-id-or-slug>');
    const client = api ?? createClientFromEnvironment();
    const blocks: NoteBlock[] = await client.listBlocks(reference);
    io.stdout(`${formatBlockSummary(blocks)}\n`);
    return;
  }

  if (command === 'block' && args[1] === 'get') {
    const reference = args[2];
    const key = args[3];
    if (!reference || !key || reference.startsWith('--') || key.startsWith('--')) usage('Usage: qnotes block get <note-id-or-slug> <block-key>');
    const client = api ?? createClientFromEnvironment();
    io.stdout(withOneFinalNewline((await client.getBlock(reference, key)).content));
    return;
  }

  if (command === 'create') {
    const title = valueAfter(args, '--title');
    const file = valueAfter(args, '--file');
    if (!title || !file) usage('Usage: qnotes create --title "Title" --file note.md');
    const client = api ?? createClientFromEnvironment();
    const contentMarkdown = await readFile(resolve(file), 'utf8');
    const created = await client.createNote({ title, contentMarkdown, tags: [], deviceId: randomUUID(), mutationId: randomUUID() });
    const notebookId = valueAfter(args, '--notebook');
    const note = notebookId ? await moveToNotebook(client, created, notebookId) : created;
    io.stdout(`${JSON.stringify(note, null, 2)}\n`);
    return;
  }

  if (command === 'capture') {
    const content = textFromArgs(args.slice(1));
    if (!content) usage('Usage: qnotes capture "Text to remember"');
    const client = api ?? createClientFromEnvironment();
    const title = content.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) ?? 'Capture';
    const note = await client.createNote({ title, contentMarkdown: `${content}\n`, tags: ['capture'], deviceId: randomUUID(), mutationId: randomUUID() });
    io.stdout(`${JSON.stringify(note, null, 2)}\n`);
    return;
  }

  if (command === 'append') {
    const reference = args[1];
    const content = textFromArgs(args.slice(2));
    if (!reference || !content) usage('Usage: qnotes append <note-id-or-slug> "Text to append"');
    const client = api ?? createClientFromEnvironment();
    const note = await client.getNote(reference);
    const next = note.contentMarkdown.trim() ? `${note.contentMarkdown.trimEnd()}\n\n${content}\n` : `${content}\n`;
    io.stdout(`${JSON.stringify(await client.updateNote(note.id, notePayload(note, next)), null, 2)}\n`);
    return;
  }

  if (command === 'export') {
    const workspace = args.includes('--workspace');
    const output = valueAfter(args, '--output');
    if (workspace) {
      if (!output) usage('Usage: qnotes export --workspace --output backup.zip [--force]');
      const client = api ?? createClientFromEnvironment();
      const bytes = new Uint8Array(await (await client.exportWorkspace()).arrayBuffer());
      await writeBinaryFile(resolve(output), bytes, args.includes('--force'));
      io.stdout(`Exported workspace to ${output}\n`);
      return;
    }
    const reference = args[1];
    if (!reference || reference.startsWith('--')) usage('Usage: qnotes export <note-id-or-slug> [--output note.md] [--force]');
    const client = api ?? createClientFromEnvironment();
    const response = await client.exportNote(reference);
    if (output) {
      await writeBinaryFile(resolve(output), new Uint8Array(await response.arrayBuffer()), args.includes('--force'));
      io.stdout(`Exported note to ${output}\n`);
    } else {
      io.stdout(withOneFinalNewline(await response.text()));
    }
    return;
  }

  usage(`Unknown command: ${command}`);
}

export async function runCli(args: string[], io: CommandIo): Promise<number> {
  try {
    await runCommand(args, io);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof CliUsageError ? 2 : 1;
    io.stderr(`qnotes: ${error instanceof Error ? error.message : String(error)}\n`);
    return code;
  }
}
