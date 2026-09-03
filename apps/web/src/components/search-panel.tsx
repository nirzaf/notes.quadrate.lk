import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { SearchFilters, SearchResponse, SearchResult, SearchSourceType } from '@qnotes/shared';
import { QNotesHttpError } from '@qnotes/api-client';
import { searchRecentNotes, rememberSearchSelection } from '../indexed-db';
import { api } from '../api';

export interface SearchState {
  query: string;
  response: SearchResponse | null;
}

interface SearchPanelProps {
  onSearchStateChange?: (state: SearchState) => void;
  notebookId?: string | null;
  unfiled?: boolean;
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

async function localMatches(query: string, filters: SearchFilters): Promise<Awaited<ReturnType<typeof searchRecentNotes>>> {
  if (filters.languages?.length || filters.sourceTypes?.some((sourceType) => sourceType === 'code_block' || sourceType === 'copy_block' || sourceType === 'attachment_chunk')) return [];
  const notes = await searchRecentNotes(query);
  const updatedAfter = filters.updatedAfter ? Date.parse(filters.updatedAfter) : NaN;
  return notes.filter((note) => {
    if (filters.notebookIds?.length && !filters.notebookIds.includes(note.notebookId ?? '')) return false;
    if (filters.unfiled && note.notebookId) return false;
    if (filters.tags?.length && !filters.tags.every((tag) => note.tags.includes(tag))) return false;
    if (Number.isFinite(updatedAfter) && Date.parse(note.updatedAt) <= updatedAfter) return false;
    return true;
  });
}

function isTransientSearchError(error: unknown): boolean {
  if (error instanceof QNotesHttpError) return error.status >= 500;
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError');
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError') || (error instanceof Error && error.name === 'AbortError');
}

export function SearchPanel({ onSearchStateChange, notebookId = null, unfiled = false, availableTags = [], onResultSelect }: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SearchSourceType | ''>('');
  const [useLocalFallback, setUseLocalFallback] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tags = useMemo(() => [...new Set(availableTags)].sort((left, right) => left.localeCompare(right)), [availableTags]);
  const filters = useMemo(() => {
    const value: SearchFilters = {};
    if (notebookId) value.notebookIds = [notebookId];
    if (tagFilter) value.tags = [tagFilter];
    if (sourceFilter) value.sourceTypes = [sourceFilter];
    if (unfiled) value.unfiled = true;
    return value;
  }, [notebookId, sourceFilter, tagFilter, unfiled]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
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
  const [localResponse, setLocalResponse] = useState<SearchResponse | null>(null);
  useEffect(() => {
    let active = true;
    if (!query.trim()) {
      setLocalResponse(null);
      return () => { active = false; };
    }
    void localMatches(query, filters).then((notes) => {
      if (!active) return;
      setLocalResponse(localSearchResponse(notes));
    });
    return () => { active = false; };
  }, [filters, query]);
  const result = useQuery({
    queryKey: ['search', debounced, filters, useLocalFallback],
    queryFn: async ({ signal }) => {
      try {
        return await api.searchPost({ query: debounced, mode: 'auto', limit: 20, maxPerNote: 2, filters }, { signal });
      } catch (error: unknown) {
        if (!useLocalFallback || !isTransientSearchError(error)) throw error;
        return localSearchResponse(await localMatches(debounced, filters));
      }
    },
    enabled: Boolean(debounced),
    staleTime: 30_000,
  });
  const displayResponse = query.trim() !== debounced
    ? (useLocalFallback ? localResponse : null)
    : result.error
      ? (isAbortError(result.error) ? null : useLocalFallback && isTransientSearchError(result.error) ? localResponse : null)
      : result.isFetching
        ? (useLocalFallback ? localResponse : null)
        : result.data ?? (useLocalFallback ? localResponse : null);
  useEffect(() => {
    onSearchStateChange?.({
      query: debounced,
      response: debounced ? displayResponse : null,
    });
  }, [debounced, displayResponse, onSearchStateChange]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDebounced(query.trim());
  };
  const matchingNoteCount = new Set(displayResponse?.items.map((item) => item.noteId)).size;
  const selectResult = (item: SearchResult) => {
    if (displayResponse) void rememberSearchSelection({ queryId: displayResponse.queryId, documentId: item.documentId ?? item.id, selectedAt: new Date().toISOString() });
    onResultSelect?.(item);
  };
  return <section aria-label="Search notes"><form className="q-search-large q-mobile-search" onSubmit={submit}><Search size={19} aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes, blocks, and attachments…" aria-label="Search notes" /><span className="q-search-kbd">⌘K</span></form><div className="q-search-options"><label><span className="q-label">Tag</span><select aria-label="Filter search by tag" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}</select></label><label><span className="q-label">Source</span><select aria-label="Filter search by source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SearchSourceType | '')}><option value="">All sources</option><option value="note_chunk">Note text</option><option value="code_block">Code</option><option value="copy_block">Copy blocks</option><option value="attachment_chunk">Attachments</option></select></label><label className="q-search-local"><input type="checkbox" checked={useLocalFallback} onChange={(event) => setUseLocalFallback(event.target.checked)} />Use recent local title/tag fallback</label></div>{debounced && !isAbortError(result.error) && <p className="q-search-status" role="status">{result.isFetching ? displayResponse ? 'Showing recent local matches while searching…' : 'Searching notes…' : result.error ? 'Search is unavailable right now.' : matchingNoteCount ? `${matchingNoteCount} matching ${matchingNoteCount === 1 ? 'note' : 'notes'}` : `No notes match “${debounced}”. Try a shorter phrase.`}</p>}{debounced && displayResponse && displayResponse.items.length > 0 && <ul className="q-search-results" aria-label="Matched search results">{displayResponse.items.map((item) => <li key={`${item.id}:${item.sourceKey}`}><button type="button" onClick={() => selectResult(item)}><strong>{item.noteTitle}</strong><span>{item.headingPath ? `${item.headingPath} · ` : ''}{item.sourceType}</span><small>{item.snippet}</small></button></li>)}</ul>}</section>;
}
