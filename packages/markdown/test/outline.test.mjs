import test from 'node:test';
import assert from 'node:assert/strict';
import { getMarkdownOutline, MarkdownPatchError, patchMarkdownSection } from '../dist/index.js';

const markdown = `# Notes

## Section

first body

## Section

second body

## Code

\`\`\`bash
# this is not a heading
echo safe
\`\`\`

:::copy{id="named"}
named block
:::`;

test('outlines headings, repeated sections, fenced code, and named blocks without bodies', async () => {
  const outline = await getMarkdownOutline(markdown);
  assert.deepEqual(outline.sections.map((section) => section.heading), ['Notes', 'Section', 'Section', 'Code']);
  assert.notEqual(outline.sections[1]?.sectionId, outline.sections[2]?.sectionId);
  assert.equal(outline.sections.some((section) => section.heading === 'this is not a heading'), false);
  assert.equal(outline.blocks.length, 2);
  assert.equal(outline.blocks[1]?.blockKey, 'named');
  assert.equal(outline.sections.every((section) => !('content' in section)), true);
});

test('patches one exact section and leaves later sections and blocks unchanged', async () => {
  const outline = await getMarkdownOutline(markdown);
  const section = outline.sections[1];
  assert.ok(section);
  const patched = await patchMarkdownSection(markdown, section.sectionId, section.contentHash, 'replacement body');
  assert.match(patched, /## Section\n\nreplacement body\n\n## Section\n\nsecond body/);
  assert.match(patched, /# this is not a heading\necho safe/);
  assert.match(patched, /:::copy\{id="named"\}\nnamed block/);
  const patchedOutline = await getMarkdownOutline(patched);
  assert.equal(patchedOutline.blocks[0]?.blockKey, outline.blocks[0]?.blockKey);
  assert.equal(patchedOutline.blocks[1]?.contentHash, outline.blocks[1]?.contentHash);
});

test('rejects a missing or stale section anchor before producing a patch', async () => {
  const outline = await getMarkdownOutline(markdown);
  const section = outline.sections[1];
  assert.ok(section);
  await assert.rejects(() => patchMarkdownSection(markdown, 'section-missing', section.contentHash, 'replacement'), (error) => error instanceof MarkdownPatchError && error.code === 'SECTION_NOT_FOUND');
  await assert.rejects(() => patchMarkdownSection(markdown, section.sectionId, '0'.repeat(64), 'replacement'), (error) => error instanceof MarkdownPatchError && error.code === 'SECTION_HASH_MISMATCH');
});
