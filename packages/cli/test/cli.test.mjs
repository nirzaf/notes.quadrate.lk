import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliUsageError, runCli, runCommand } from '../dist/commands.js';

function io() {
  const output = { stdout: '', stderr: '' };
  return { output, io: { stdout: (value) => { output.stdout += value; }, stderr: (value) => { output.stderr += value; } } };
}

const note = { id: '11111111-1111-4111-8111-111111111111', slug: 'demo', title: 'Demo', contentMarkdown: '# Demo\n\nbody\n', contentPlain: 'Demo\nbody', tags: ['demo'], notebookId: null, version: 1, createdAt: '2026-08-31T00:00:00Z', updatedAt: '2026-08-31T00:00:00Z', deletedAt: null };
const block = { id: '22222222-2222-4222-8222-222222222222', noteId: note.id, blockKey: 'deploy', blockType: 'command', title: 'Deploy', language: 'bash', content: 'docker compose up -d', position: 0, copyable: true, contentHash: 'x' };

test('invalid CLI usage returns exit code 2', async () => {
  const { output, io: streams } = io();
  assert.equal(await runCli(['search'], streams), 2);
  assert.match(output.stderr, /Usage: qnotes search/);
});

test('raw block output contains no decoration', async () => {
  const { output, io: streams } = io();
  await runCommand(['block', 'get', 'demo', 'deploy'], streams, { getBlock: async () => block });
  assert.equal(output.stdout, 'docker compose up -d\n');
});

test('JSON search output is valid JSON', async () => {
  const { output, io: streams } = io();
  const response = { items: [{ noteTitle: 'Demo', sourceTitle: 'Deploy', snippet: 'x' }], queryId: '33333333-3333-4333-8333-333333333333', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } };
  await runCommand(['search', 'deploy', '--json'], streams, { search: async () => response });
  assert.deepEqual(JSON.parse(output.stdout), response);
});

test('human search output renders items from the response envelope', async () => {
  const { output, io: streams } = io();
  await runCommand(['search', 'deploy'], streams, { search: async () => ({ items: [{ noteTitle: 'Demo', sourceTitle: 'Deploy', snippet: 'x' }], queryId: '33333333-3333-4333-8333-333333333333', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } }) });
  assert.match(output.stdout, /1\. Demo · Deploy\n   x/);
});

test('search forwards pagination flags without adding their values to the query', async () => {
  const { output, io: streams } = io();
  let searchInput;
  const response = { items: [], queryId: '33333333-3333-4333-8333-333333333333', modeUsed: 'keyword', degraded: false, timing: { embeddingMs: 0, retrievalMs: 1, totalMs: 1 } };
  await runCommand(['search', 'deploy', '--limit', '500', '--cursor', 'opaque-cursor', '--json'], streams, {
    search: async (input) => { searchInput = input; return response; },
  });
  assert.deepEqual(searchInput, { query: 'deploy', mode: 'auto', limit: 500, cursor: 'opaque-cursor' });
  assert.deepEqual(JSON.parse(output.stdout), response);
});

test('invalid search limit is a usage error', async () => {
  const { output, io: streams } = io();
  let searchCalls = 0;
  await assert.rejects(() => runCommand(['search', 'deploy', '--limit', 'not-a-number'], streams, {
    search: async () => { searchCalls += 1; return { items: [] }; },
  }), (error) => error instanceof CliUsageError && /Usage: qnotes search/.test(error.message));
  assert.equal(searchCalls, 0);
  assert.equal(output.stdout, '');
});

test('existing export target is not overwritten without --force', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qnotes-cli-'));
  const target = join(directory, 'note.md');
  await writeFile(target, 'original');
  const { io: streams } = io();
  await assert.rejects(() => runCommand(['export', 'demo', '--output', target], streams, { exportNote: async () => new Response('replacement') }));
  assert.equal(await readFile(target, 'utf8'), 'original');
});

test('lists notebooks and moves a note to a notebook', async () => {
  const { output, io: streams } = io();
  let moveInput;
  await runCommand(['notebooks'], streams, { listNotebooks: async () => ({ items: [{ id: 'n-1', name: 'Work' }] }) });
  await runCommand(['notebook', 'move', 'demo', 'n-1'], streams, {
    getNote: async () => note,
    moveNoteToNotebook: async (noteId, input) => { moveInput = { noteId, input }; return { ...note, notebookId: input.notebookId, version: 2 }; },
  });
  assert.match(output.stdout, /"name": "Work"/);
  assert.equal(moveInput.noteId, note.id);
  assert.equal(moveInput.input.notebookId, 'n-1');
});
