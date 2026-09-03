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

test('overlaps token-aware chunks without renumbering stable identities', async () => {
  const words = Array.from({ length: 701 }, (_, index) => `word${index}`).join(' ');
  const chunks = await chunkMarkdown(`# Long\n\n${words}`, 'Long');
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.content.split(/\s+/).filter(Boolean).length <= 350));
  assert.ok(chunks.some((chunk, index) => index > 0 && chunks[index - 1]?.content.split(/\s+/).some((word) => chunk.content.split(/\s+/).includes(word))));
  const stableWords = Array.from({ length: 701 }, (_, index) => `stable${index}`).join(' ');
  const before = await chunkMarkdown(`# Stable\n\n${stableWords}`, 'Stable');
  const after = await chunkMarkdown(`# Stable\n\ninserted paragraph.\n\n${stableWords}`, 'Stable');
  assert.ok(after.some((chunk) => before.some((previous) => previous.sourceKey === chunk.sourceKey)));
});
