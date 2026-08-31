import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownParseError, parseMarkdown } from '../dist/index.js';

const example = `# Deploy ERPNext

:::copy{id="production-deploy" title="Production Deploy" lang="bash" type="command"}
docker compose pull
docker compose up -d
docker compose ps
:::`;

test('parses the required named copy block', async () => {
  const parsed = await parseMarkdown(example);
  assert.deepEqual(parsed.blocks.map(({ contentHash: _hash, ...block }) => block), [{
    blockKey: 'production-deploy',
    blockType: 'command',
    title: 'Production Deploy',
    language: 'bash',
    content: 'docker compose pull\ndocker compose up -d\ndocker compose ps',
    position: 0,
    copyable: true,
    explicit: true,
  }]);
});

test('uses named block defaults and preserves internal newlines', async () => {
  const parsed = await parseMarkdown(':::copy{id="runbook"}\nfirst\n\nsecond\n:::');
  assert.equal(parsed.blocks[0]?.title, 'runbook');
  assert.equal(parsed.blocks[0]?.blockType, 'copy');
  assert.equal(parsed.blocks[0]?.language, null);
  assert.equal(parsed.blocks[0]?.content, 'first\n\nsecond');
});

test('rejects invalid attributes and ids', async () => {
  await assert.rejects(() => parseMarkdown(':::copy{unknown="x" id="ok"}\nx\n:::'), (error) => error instanceof MarkdownParseError && error.code === 'INVALID_COPY_BLOCK');
  await assert.rejects(() => parseMarkdown(':::copy{title="missing id"}\nx\n:::'), (error) => error instanceof MarkdownParseError && error.code === 'INVALID_COPY_BLOCK');
  await assert.rejects(() => parseMarkdown(':::copy{id="Bad"}\nx\n:::'), (error) => error instanceof MarkdownParseError && error.code === 'INVALID_COPY_BLOCK');
  await assert.rejects(() => parseMarkdown(':::copy{id="ok" id="again"}\nx\n:::'), (error) => error instanceof MarkdownParseError && error.code === 'INVALID_COPY_BLOCK');
  await assert.rejects(() => parseMarkdown(':::copy{id="ok"}\nx'), (error) => error instanceof MarkdownParseError && error.code === 'INVALID_COPY_BLOCK');
});

test('rejects duplicate named ids', async () => {
  await assert.rejects(() => parseMarkdown(':::copy{id="deploy"}\nfirst\n:::\n\n:::copy{id="deploy"}\nsecond\n:::'), (error) => error instanceof MarkdownParseError && error.code === 'DUPLICATE_BLOCK_KEY');
});

test('extracts ordinary fenced code with stable occurrence ids', async () => {
  const markdown = '```bash\necho one\n```\n\n```bash\necho one\n```\n\n```sql\nselect 1;\n```';
  const first = await parseMarkdown(markdown);
  const second = await parseMarkdown(markdown);
  assert.equal(first.blocks.length, 3);
  assert.deepEqual(first.blocks.map((block) => block.blockKey), second.blocks.map((block) => block.blockKey));
  assert.equal(first.blocks[0]?.blockType, 'code');
  assert.equal(first.blocks[0]?.explicit, false);
  assert.notEqual(first.blocks[0]?.blockKey, first.blocks[1]?.blockKey);
});

test('plain text includes each content kind once without markdown punctuation', async () => {
  const parsed = await parseMarkdown('# Heading\n\nA **paragraph**.\n\n- item\n\n:::copy{id="copy"}\ncopy text\n:::\n\n```txt\ncode text\n```');
  assert.match(parsed.plainText, /Heading/);
  assert.match(parsed.plainText, /paragraph/);
  assert.match(parsed.plainText, /item/);
  assert.equal(parsed.plainText.match(/copy text/g)?.length, 1);
  assert.equal(parsed.plainText.match(/code text/g)?.length, 1);
  assert.doesNotMatch(parsed.plainText, /\*\*/);
});
