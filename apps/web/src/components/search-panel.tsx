import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Search, Copy, ArrowUpRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { SearchMode, SearchResult } from '@qnotes/shared';
import { api } from '../api';
import { Button } from './ui/button';
import { useToast } from './ui/toast';

interface SearchPanelProps { onOpenNote?: (noteId: string) => void; }

async function copy(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  throw new Error('Clipboard unavailable');
}

function Result({ result, onOpenNote }: { result: SearchResult; onOpenNote?: ((noteId: string) => void) | undefined }): JSX.Element {
  const { toast } = useToast();
  const copyResult = async () => {
    try {
      const value = result.blockKey ? (await api.getBlock(result.noteId, result.blockKey)).content : result.snippet;
      await copy(value);
      toast('Result copied.', 'success');
    } catch {
      toast('Clipboard access was unavailable.', 'error');
    }
  };
  return <article className="q-result"><div><p className="q-result-title">{result.sourceTitle || result.noteTitle}</p><p className="q-result-meta">{result.noteTitle} · {result.sourceType}{result.headingPath ? ` · ${result.headingPath}` : ''}</p><p className="q-result-snippet">{result.snippet}</p></div><div className="q-toolbar q-result-copy">{result.copyable && <Button variant="secondary" size="sm" onClick={() => void copyResult()}><Copy size={14} aria-hidden="true" />Copy</Button>}<Button variant="ghost" size="icon" onClick={() => onOpenNote?.(result.noteId)} aria-label={`Open ${result.noteTitle}`}><ArrowUpRight size={17} aria-hidden="true" /></Button></div></article>;
}

export function SearchPanel({ onOpenNote }: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [mode, setMode] = useState<SearchMode>('keyword');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 100);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, []);
  const result = useQuery({ queryKey: ['search', debounced, mode], queryFn: () => api.search({ query: debounced, mode }), enabled: Boolean(debounced) });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim()) return;
    setMode('hybrid');
    setDebounced(query.trim());
  };
  return <section aria-label="Search notes"><form className="q-search-large q-mobile-search" onSubmit={submit}><Search size={19} aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setMode('keyword'); }} placeholder="Search your notes, blocks, and attachments…" aria-label="Search notes" /><span className="q-search-kbd">⌘K</span></form>{debounced && <div className="q-results" aria-live="polite">{result.isLoading ? <div className="q-empty">Searching…</div> : result.error ? <div className="q-error">Search is unavailable right now.</div> : result.data?.length ? result.data.map((item) => <Result key={item.id} result={item} onOpenNote={onOpenNote} />) : <div className="q-empty">No matches for “{debounced}”.</div>}</div>}</section>;
}
