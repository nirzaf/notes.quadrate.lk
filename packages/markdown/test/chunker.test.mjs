import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../dist/index.js';

test('chunks by heading hierarchy and preserves paragraph boundaries', async () => {
  const chunks = await chunkMarkdown('# ERPNext\n\n## Docker deployment\n\nfirst paragraph.\n\nsecond paragraph.', 'ERPNext');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.headingPath, 'ERPNext > Docker deployment');
  assert.match(chunks[0]?.content ?? '', /first paragraph/);
  assert.match(chunks[0]?.content ?? '', /second paragraph/);
  assert.equal(chunks[0]?.sourceTitle, 'ERPNext');
});

test('splits an overlong paragraph at 350 words', async () => {
  const words = Array.from({ length: 701 }, (_, index) => `word${index}`).join(' ');
  const chunks = await chunkMarkdown(`# Long\n\n${words}`, 'Long');
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.content.split(/\s+/).length <= 350));
  assert.deepEqual(chunks.map((chunk) => chunk.position), [0, 1, 2]);
  assert.ok(chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.contentHash)));
});
