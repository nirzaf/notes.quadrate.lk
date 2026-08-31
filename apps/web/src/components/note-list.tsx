import type { NoteSummary } from '@qnotes/shared';
import { Badge } from './ui/badge';
import { formatUpdatedAt } from '../lib/utils';

interface NoteListProps {
  notes: NoteSummary[];
  activeNoteId?: string | undefined;
  onSelect: (noteId: string) => void;
  onNew: () => void;
}

export function NoteList({ notes, activeNoteId, onSelect, onNew }: NoteListProps): JSX.Element {
  return <section className="q-note-list" aria-label="Notes">
    <div className="q-note-list-title"><span>Your notes</span><button className="q-button q-button-ghost q-button-sm" onClick={onNew} aria-label="Create a new note">New</button></div>
    <div className="q-note-items">
      {notes.length === 0 ? <div className="q-empty">No notes yet. Start with a fresh page.</div> : notes.map((note) => <button className={`q-note-item ${activeNoteId === note.id ? 'q-note-item-active' : ''}`} key={note.id} onClick={() => onSelect(note.id)} aria-current={activeNoteId === note.id ? 'page' : undefined}>
        <span className="q-note-item-heading"><span className="q-note-item-title">{note.title}</span><span className="q-note-item-time">{formatUpdatedAt(note.updatedAt)}</span></span>
        <span className="q-note-item-excerpt">{note.excerpt || 'Empty note'}</span>
        <span className="q-tag-row">{note.tags.slice(0, 3).map((tag) => <Badge key={tag}>{tag}</Badge>)}</span>
      </button>)}
    </div>
  </section>;
}
