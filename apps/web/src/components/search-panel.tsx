import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { SearchResponse, SearchResult, SearchSourceType } from '@qnotes/shared';
import { searchRecentNotes, rememberSearchSelection } from '../indexed-db';
import { api } from '../api';

export interface SearchState {
  query: string;
  response: SearchResponse | null;
}

interface SearchPanelProps {
  onSearchStateChange?: (state: SearchState) => void;
  notebookId?: string | null;
  availableTags?: string[];
  onResultSelect?: (result: SearchResult) => void;
}

function localSearchResponse(notes: Awaited<ReturnType<typeof searchRecentNotes>>): SearchResponse {
  return {
    queryId: crypto.randomUUID(),
    modeUsed: 'keyword',
    degraded: true,
    degradedReason: 'LOCAL_FALLBACK',
    timing: { embeddingMs: 0, retrievalMs: 0, totalMs: 0 },
    index: { model: 'local-cache', pendingDocuments: 0, failedDocuments: 0, oldestPendingAgeSeconds: null, fresh: false },
    nextCursor: null,
    items: notes.map((note, index) => ({
      id: note.id,
      documentId: note.id,
      noteId: note.id,
      noteVersion: note.version,
      noteSlug: note.slug,
      noteTitle: note.title,
      sourceType: 'note_metadata',
      sourceId: null,
      sourceKey: 'local-note-metadata',
      sourceTitle: note.title,
      headingPath: null,
      snippet: note.excerpt,
      score: 1 - index / Math.max(notes.length, 1),
      keywordRank: index + 1,
      semanticRank: null,
      copyable: false,
      blockKey: null,
      language: null,
      attachmentId: null,
      uri: `qnotes://notes/${note.id}`,
      tags: note.tags,
      notebookId: note.notebookId,
      updatedAt: note.updatedAt,
      matchReasons: ['local_title_or_tag_match'],
      scores: { hybrid: 1 - index / Math.max(notes.length, 1), keywordRank: index + 1, semanticRank: null },
    })),
  };
}

export function SearchPanel({ onSearchStateChange, notebookId = null, availableTags = [], onResultSelect }: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SearchSourceType | ''>('');
  const [useLocalFallback, setUseLocalFallback] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tags = useMemo(() => [...new Set(availableTags)].sort((left, right) => left.localeCompare(right)), [availableTags]);
  const filters = useMemo(() => {
    const value: { notebookIds?: string[]; tags?: string[]; sourceTypes?: SearchSourceType[] } = {};
    if (notebookId) value.notebookIds = [notebookId];
    if (tagFilter) value.tags = [tagFilter];
    if (sourceFilter) value.sourceTypes = [sourceFilter];
    return value;
  }, [notebookId, sourceFilter, tagFilter]);
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
    queryKey: ['search', debounced, filters, useLocalFallback],
    queryFn: async () => {
      try {
        return await api.searchPost({ query: debounced, mode: 'auto', limit: 50, maxPerNote: 2, filters });
      } catch (error: unknown) {
        if (!useLocalFallback) throw error;
        return localSearchResponse(await searchRecentNotes(debounced));
      }
    },
    enabled: Boolean(debounced),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    onSearchStateChange?.({
      query: debounced,
      response: debounced && !result.isFetching && !result.error ? result.data ?? null : null,
    });
  }, [debounced, onSearchStateChange, result.data, result.error, result.isFetching]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDebounced(query.trim());
  };
  const matchingNoteCount = new Set(result.data?.items.map((item) => item.noteId)).size;
  const selectResult = (item: SearchResult) => {
    if (result.data) void rememberSearchSelection({ queryId: result.data.queryId, documentId: item.documentId ?? item.id, selectedAt: new Date().toISOString() });
    onResultSelect?.(item);
  };
  return <section aria-label="Search notes"><form className="q-search-large q-mobile-search" onSubmit={submit}><Search size={19} aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes, blocks, and attachments…" aria-label="Search notes" /><span className="q-search-kbd">⌘K</span></form><div className="q-search-options"><label><span className="q-label">Tag</span><select aria-label="Filter search by tag" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}</select></label><label><span className="q-label">Source</span><select aria-label="Filter search by source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SearchSourceType | '')}><option value="">All sources</option><option value="note_chunk">Note text</option><option value="code_block">Code</option><option value="copy_block">Copy blocks</option><option value="attachment_chunk">Attachments</option></select></label><label className="q-search-local"><input type="checkbox" checked={useLocalFallback} onChange={(event) => setUseLocalFallback(event.target.checked)} />Use recent local title/tag fallback</label></div>{debounced && <p className="q-search-status" role="status">{result.isFetching ? 'Searching notes…' : result.error ? 'Search is unavailable right now.' : matchingNoteCount ? `${matchingNoteCount} matching ${matchingNoteCount === 1 ? 'note' : 'notes'}` : `No notes match “${debounced}”. Try a shorter phrase.`}</p>}{debounced && result.data && !result.isFetching && result.data.items.length > 0 && <ul className="q-search-results" aria-label="Matched search results">{result.data.items.map((item) => <li key={`${item.id}:${item.sourceKey}`}><button type="button" onClick={() => selectResult(item)}><strong>{item.noteTitle}</strong><span>{item.headingPath ? `${item.headingPath} · ` : ''}{item.sourceType}</span><small>{item.snippet}</small></button></li>)}</ul>}</section>;
}
