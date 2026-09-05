import { Copy, Download, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import type { Note } from '@qnotes/shared';
import DOMPurify from 'dompurify';
import { MarkdownParseError, renderMarkdown } from '@qnotes/markdown';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { useToast } from './ui/toast';

interface NoteToolbarProps {
  note: Note;
  onDelete: () => void;
  onRestore: () => void;
  onExport: () => void;
}

async function copyPlain(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const element = document.createElement('textarea');
  element.value = value;
  element.style.position = 'fixed';
  element.style.opacity = '0';
  document.body.append(element);
  element.select();
  if (!document.execCommand('copy')) throw new Error('Clipboard access was unavailable.');
  element.remove();
}

export function NoteToolbar({ note, onDelete, onRestore, onExport }: NoteToolbarProps): JSX.Element {
  const { toast } = useToast();
  const copy = async (kind: 'markdown' | 'plain' | 'rendered') => {
    try {
      if (kind === 'markdown') await copyPlain(note.contentMarkdown);
      else {
        const rendered = await renderMarkdown(note.contentMarkdown);
        if (kind === 'plain') await copyPlain(rendered.plainText);
        else if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          const html = DOMPurify.sanitize(rendered.html);
          await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([rendered.plainText], { type: 'text/plain' }) })]);
        } else await copyPlain(rendered.plainText);
      }
      toast(`${kind === 'markdown' ? 'Markdown' : kind === 'plain' ? 'Plain text' : 'Rendered content'} copied.`, 'success');
    } catch (error: unknown) {
      toast(error instanceof MarkdownParseError ? 'This draft could not be converted for copying. Check the Markdown blocks and try again.' : 'Clipboard access was unavailable.', 'error');
    }
  };
  return <div className="q-toolbar" aria-label="Note actions">
    <Button onClick={() => void copy('markdown')}><Copy size={16} aria-hidden="true" />Copy Markdown</Button>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More copy options"><MoreHorizontal size={18} aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => void copy('plain')}>Copy Plain Text</DropdownMenuItem><DropdownMenuItem onSelect={() => void copy('rendered')}>Copy Rendered Content</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More note actions"><MoreHorizontal size={18} aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={onExport}><Download size={15} aria-hidden="true" />Export current draft</DropdownMenuItem>{note.deletedAt ? <DropdownMenuItem onSelect={onRestore}><RotateCcw size={15} aria-hidden="true" />Restore note</DropdownMenuItem> : <DropdownMenuItem onSelect={onDelete}><Trash2 size={15} aria-hidden="true" />Move to Trash</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
  </div>;
}
