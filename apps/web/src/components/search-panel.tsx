import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult } from '@qnotes/shared';
import { api } from '../api';

export interface SearchState {
  query: string;
  results: SearchResult[] | null;
}

interface SearchPanelProps { onSearchStateChange?: (state: SearchState) => void; }

export function SearchPanel({ onSearchStateChange }: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
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
  const result = useQuery({
    queryKey: ['search', debounced],
    queryFn: ({ signal }) => api.search({ query: debounced, mode: 'keyword', limit: 50, signal }),
    enabled: Boolean(debounced),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    onSearchStateChange?.({
      query: debounced,
      results: debounced && !result.isFetching && !result.error ? result.data ?? [] : null,
    });
  }, [debounced, onSearchStateChange, result.data, result.error, result.isFetching]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDebounced(query.trim());
  };
  const matchingNoteCount = new Set(result.data?.map((item) => item.noteId)).size;
  return <section aria-label="Search notes"><form className="q-search-large q-mobile-search" onSubmit={submit}><Search size={19} aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes, blocks, and attachments…" aria-label="Search notes" /><span className="q-search-kbd">⌘K</span></form>{debounced && <p className="q-search-status" role="status">{result.isFetching ? 'Searching notes…' : result.error ? 'Search is unavailable right now.' : matchingNoteCount ? `${matchingNoteCount} matching ${matchingNoteCount === 1 ? 'note' : 'notes'}` : `No notes match “${debounced}”. Try a shorter phrase.`}</p>}</section>;
}
