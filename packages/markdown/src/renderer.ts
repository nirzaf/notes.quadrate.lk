import MarkdownIt from 'markdown-it';
import type { ParsedBlock, RenderedMarkdown } from '@qnotes/shared';
import { parseBlocks, plainTextFromMarkdown } from './parser.js';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function blockCard(block: ParsedBlock): string {
  const label = block.title ?? block.language ?? 'Code';
  const language = block.language ? `<span class="qnotes-block-language">${escapeHtml(block.language)}</span>` : '';
  return `<section class="qnotes-block" data-qnotes-block-key="${escapeHtml(block.blockKey)}"><header><strong>${escapeHtml(label)}</strong>${language}<button type="button" data-qnotes-block-key="${escapeHtml(block.blockKey)}">Copy</button></header><pre><code>${escapeHtml(block.content)}</code></pre></section>`;
}

export async function renderMarkdown(markdown: string): Promise<RenderedMarkdown> {
  const { blocks, markdownWithoutNamedBlocks } = await parseBlocks(markdown);
  const codeBlocks = blocks.filter((block) => !block.explicit);
  const seen = new Map<string, number>();
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = (token?.info ?? '').trim().split(/\s+/)[0] ?? '';
    const content = (token?.content ?? '').replace(/\n$/, '');
    const key = `${language}\0${content}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const block = codeBlocks.filter((candidate) => (candidate.language ?? '') === language && candidate.content === content)[occurrence];
    return block ? blockCard(block) : `<pre><code>${escapeHtml(content)}</code></pre>`;
  };
  const named = blocks.filter((block) => block.explicit).map(blockCard).join('');
  return { html: `${md.render(markdownWithoutNamedBlocks)}${named}`, plainText: await plainTextFromMarkdown(markdown), blocks };
}
