import { Copy, Download, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import type { Note } from '@qnotes/shared';
import { renderMarkdown } from '@qnotes/markdown';
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
  document.execCommand('copy');
  element.remove();
}

export function NoteToolbar({ note, onDelete, onRestore, onExport }: NoteToolbarProps): JSX.Element {
  const { toast } = useToast();
  const copy = async (kind: 'markdown' | 'plain' | 'rendered') => {
    try {
      if (kind === 'markdown') await copyPlain(note.contentMarkdown);
      else if (kind === 'plain') await copyPlain(note.contentPlain);
      else {
        const rendered = await renderMarkdown(note.contentMarkdown);
        if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([rendered.html], { type: 'text/html' }), 'text/plain': new Blob([rendered.plainText], { type: 'text/plain' }) })]);
        } else await copyPlain(rendered.plainText);
      }
      toast(`${kind === 'markdown' ? 'Markdown' : kind === 'plain' ? 'Plain text' : 'Rendered content'} copied.`, 'success');
    } catch {
      toast('Clipboard access was unavailable.', 'error');
    }
  };
  return <div className="q-toolbar" aria-label="Note actions">
    <Button onClick={() => void copy('markdown')}><Copy size={16} aria-hidden="true" />Copy Markdown</Button>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More copy options"><MoreHorizontal size={18} aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => void copy('plain')}>Copy Plain Text</DropdownMenuItem><DropdownMenuItem onSelect={() => void copy('rendered')}>Copy Rendered Content</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    <Button variant="outline" onClick={onExport}><Download size={16} aria-hidden="true" />Export</Button>
    {note.deletedAt ? <Button variant="secondary" onClick={onRestore}><RotateCcw size={16} aria-hidden="true" />Restore</Button> : <Button variant="ghost" onClick={onDelete}><Trash2 size={16} aria-hidden="true" />Delete</Button>}
  </div>;
}
