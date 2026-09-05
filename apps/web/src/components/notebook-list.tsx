import { BookOpen, Inbox, Library, Plus, X } from 'lucide-react';
import type { Notebook } from '@qnotes/shared';
import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';

export const UNFILED_NOTEBOOK_ID = '__unfiled__';

interface NotebookListProps {
  idPrefix?: string;
  notebooks: Notebook[];
  selectedNotebookId: string | null;
  onSelect: (notebookId: string | null) => void;
  onCreate: (name: string) => Promise<void>;
}

export function NotebookList({ idPrefix = 'notebook', notebooks, selectedNotebookId, onSelect, onCreate }: NotebookListProps): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(trimmed);
      setName('');
      setCreating(false);
    } catch {
      // The parent reports the API error and leaves the form open for correction.
    } finally {
      setSubmitting(false);
    }
  };

  return <section className="q-notebook-list" aria-label="Notebooks">
    <div className="q-notebook-list-heading">
      <span>Notebooks</span>
      <Button type="button" variant="ghost" size="icon" className="q-notebook-add" onClick={() => setCreating((current) => !current)} aria-label={creating ? 'Cancel new notebook' : 'Create a notebook'}>
        {creating ? <X size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}
      </Button>
    </div>
    <div className="q-notebook-items">
      <button className="q-notebook-item" data-active={selectedNotebookId === null} type="button" onClick={() => onSelect(null)} aria-pressed={selectedNotebookId === null}>
        <Library size={16} aria-hidden="true" /><span className="q-notebook-name">All notes</span>
      </button>
      <button className="q-notebook-item" data-active={selectedNotebookId === UNFILED_NOTEBOOK_ID} type="button" onClick={() => onSelect(UNFILED_NOTEBOOK_ID)} aria-pressed={selectedNotebookId === UNFILED_NOTEBOOK_ID}>
        <Inbox size={16} aria-hidden="true" /><span className="q-notebook-name">Unfiled</span>
      </button>
      {notebooks.map((notebook) => <button className="q-notebook-item" data-active={selectedNotebookId === notebook.id} type="button" key={notebook.id} onClick={() => onSelect(notebook.id)} aria-pressed={selectedNotebookId === notebook.id}>
        <BookOpen size={16} aria-hidden="true" /><span className="q-notebook-name">{notebook.name}</span>
      </button>)}
    </div>
    {creating ? <form className="q-notebook-creator" onSubmit={(event) => void submit(event)}>
      <label className="q-label" htmlFor={`${idPrefix}-new-notebook-name`}>New notebook</label>
      <div className="q-notebook-creator-row"><Input id={`${idPrefix}-new-notebook-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Work" maxLength={80} autoFocus disabled={submitting} /><Button type="submit" size="sm" disabled={submitting || !name.trim()}>{submitting ? 'Adding…' : 'Add'}</Button></div>
    </form> : null}
  </section>;
}
