import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCommand } from '../dist/commands.js';

function io() {
  const output = { stdout: '', stderr: '' };
  return { output, io: { stdout: (value) => { output.stdout += value; }, stderr: (value) => { output.stderr += value; } } };
}

const note = { id: '11111111-1111-4111-8111-111111111111', slug: 'demo', title: 'Demo', contentMarkdown: '# Demo\n\nbody\n', contentPlain: 'Demo\nbody', tags: ['demo'], version: 1, createdAt: '2026-08-31T00:00:00Z', updatedAt: '2026-08-31T00:00:00Z', deletedAt: null };
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
  await runCommand(['search', 'deploy', '--json'], streams, { search: async () => [ { noteTitle: 'Demo', sourceTitle: 'Deploy', snippet: 'x' } ] });
  assert.deepEqual(JSON.parse(output.stdout), [{ noteTitle: 'Demo', sourceTitle: 'Deploy', snippet: 'x' }]);
});

test('existing export target is not overwritten without --force', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qnotes-cli-'));
  const target = join(directory, 'note.md');
  await writeFile(target, 'original');
  const { io: streams } = io();
  await assert.rejects(() => runCommand(['export', 'demo', '--output', target], streams, { exportNote: async () => new Response('replacement') }));
  assert.equal(await readFile(target, 'utf8'), 'original');
});
