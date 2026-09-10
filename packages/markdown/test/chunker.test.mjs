import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDING_INPUT_BYTE_BUDGET,
  embeddingInput,
  embeddingInputByteLength,
  embeddingInputHash,
  splitEmbeddingContent,
  chunkMarkdown,
  chunkText,
  estimateTokenCount,
} from '../dist/index.js';

test('bounds complete embedding inputs and keeps oversized tail content', async () => {
  const sourceTitle = 'Long title '.repeat(30);
  const headingPath = '設定 > 長い見出し '.repeat(40);
  const content = Array.from({ length: 40 }, (_, index) => `const setting_${index} = "value-${index}";`).join('\n')
    + '\nTAIL_RETRIEVAL_MARKER_8241';
  const chunks = splitEmbeddingContent(content, sourceTitle, headingPath);

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks, splitEmbeddingContent(content, sourceTitle, headingPath));
  assert.match(chunks.at(-1), /TAIL_RETRIEVAL_MARKER_8241/);
  assert.ok(chunks.every((chunk) => embeddingInputByteLength(embeddingInput({ content: chunk, sourceTitle, headingPath })) <= EMBEDDING_INPUT_BYTE_BUDGET));
  assert.equal(await embeddingInputHash({ content: chunks[0], sourceTitle, headingPath }), await embeddingInputHash({ content: chunks[0], sourceTitle, headingPath }));
});

test('splits an unbroken token to the deterministic token budget', () => {
  const chunks = chunkText('x'.repeat(5000), 10, 0);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => estimateTokenCount(chunk) <= 10));
});

test('prefers sentence boundaries before word boundaries', () => {
  const chunks = chunkText('First sentence. Second sentence.', 4, 0);
  assert.deepEqual(chunks, ['First sentence.', 'Second sentence.']);
});

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
