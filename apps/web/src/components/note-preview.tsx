import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { ParsedBlock } from '@qnotes/shared';
import { renderMarkdown } from '@qnotes/markdown';
import { useToast } from './ui/toast';

interface NotePreviewProps { markdown: string; onBlockCopied?: (block: ParsedBlock) => void; }

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function NotePreview({ markdown, onBlockCopied }: NotePreviewProps): JSX.Element {
  const [html, setHtml] = useState('');
  const blockMap = useRef(new Map<string, ParsedBlock>());
  const { toast } = useToast();
  useEffect(() => {
    let active = true;
    void renderMarkdown(markdown).then((rendered) => {
      if (!active) return;
      const sanitized = DOMPurify.sanitize(rendered.html).replaceAll('<a ', '<a rel="noopener noreferrer" ');
      setHtml(sanitized);
      blockMap.current = new Map(rendered.blocks.map((block) => [block.blockKey, block]));
    }).catch(() => { if (active) setHtml('<p>Unable to render this Markdown.</p>'); });
    return () => { active = false; };
  }, [markdown]);
  const click = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button[data-qnotes-block-key]');
    if (!button) return;
    const key = button.getAttribute('data-qnotes-block-key');
    const block = key ? blockMap.current.get(key) : undefined;
    if (!block) return;
    void copyText(block.content).then(() => { toast('Block copied to clipboard.', 'success'); onBlockCopied?.(block); }).catch(() => toast('Clipboard access was unavailable.', 'error'));
  };
  return <div className="q-preview" onClick={click} dangerouslySetInnerHTML={{ __html: html }} aria-label="Rendered note preview" />;
}
