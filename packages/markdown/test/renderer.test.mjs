import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../dist/index.js';

test('renders safe block cards with copy metadata', async () => {
  const rendered = await renderMarkdown('# Test\n\n:::copy{id="safe" title="Run"}\n<script>alert(1)</script>\n:::');
  assert.match(rendered.html, /data-qnotes-block-key="safe"/);
  assert.match(rendered.html, />Copy<\/button>/);
  assert.doesNotMatch(rendered.html, /<script>alert/);
  assert.match(rendered.html, /&lt;script&gt;/);
});

test('renders fenced code through the same copyable block path', async () => {
  const rendered = await renderMarkdown('```bash\necho hello\n```');
  assert.match(rendered.html, /data-qnotes-block-key="auto-[a-f0-9]{16}"/);
  assert.match(rendered.html, /echo hello/);
});
