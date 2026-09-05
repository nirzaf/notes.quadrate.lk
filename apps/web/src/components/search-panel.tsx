import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { Notebook, SearchFilters, SearchResponse, SearchResult, SearchSourceType } from '@qnotes/shared';
import { MAX_TAG_LENGTH } from '@qnotes/shared';
import { QNotesHttpError } from '@qnotes/api-client';
import { searchRecentNotes, rememberSearchSelection } from '../indexed-db';
import { api } from '../api';
import { searchShortcutLabel, UNFILED_SEARCH_NOTEBOOK, type AppSearchPatch } from '../navigation-context';
import { Button } from './ui/button';
import { useToast } from './ui/toast';
import { useAuth } from '../auth-context';
import { noteQueryKeys } from '../note-query-keys';

export interface SearchState {
  query: string;
  response: SearchResponse | null;
  scopeKey?: string;
}

interface SearchPanelProps {
  onSearchStateChange?: (state: SearchState) => void;
  notebookId?: string | null;
  unfiled?: boolean;
  selectedNotebookId?: string | null;
  notebooks?: Notebook[];
  availableTags?: string[];
  initialQuery?: string;
  initialTag?: string;
  initialSource?: SearchSourceType | '' | undefined;
  onNotebookChange?: (notebookId: string | null) => void;
  onSearchParamsChange?: (params: AppSearchPatch, options?: { replace?: boolean }) => void;
  onResultSelect?: (result: SearchResult) => void;
}

function localSearchResponse(notes: Awaited<ReturnType<typeof searchRecentNotes>>): SearchResponse {
  return {
    queryId: crypto.randomUUID(), modeUsed: 'keyword', degraded: true, degradedReason: 'LOCAL_FALLBACK',
    timing: { embeddingMs: 0, retrievalMs: 0, totalMs: 0 },
    index: { model: 'local-cache', pendingDocuments: 0, failedDocuments: 0, oldestPendingAgeSeconds: null, fresh: false },
    nextCursor: null,
    items: notes.map((note, index) => ({
      id: note.id, documentId: note.id, noteId: note.id, noteVersion: note.version, noteSlug: note.slug, noteTitle: note.title,
      sourceType: 'note_metadata', sourceId: null, sourceKey: 'local-note-metadata', sourceTitle: note.title, headingPath: null,
      snippet: note.excerpt, score: 1 - index / Math.max(notes.length, 1), keywordRank: index + 1, semanticRank: null,
      copyable: false, blockKey: null, language: null, attachmentId: null, uri: `qnotes://notes/${note.id}`,
      tags: note.tags, notebookId: note.notebookId, updatedAt: note.updatedAt, matchReasons: ['local_title_or_tag_match'],
      scores: { hybrid: 1 - index / Math.max(notes.length, 1), keywordRank: index + 1, semanticRank: null },
    })),
  };
}

async function localMatches(query: string, filters: SearchFilters, userId: string): Promise<Awaited<ReturnType<typeof searchRecentNotes>>> {
  if (filters.languages?.length || filters.sourceTypes?.some((sourceType) => sourceType === 'code_block' || sourceType === 'copy_block' || sourceType === 'attachment_chunk')) return [];
  const notes = await searchRecentNotes(query, userId);
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

function sourceLabel(sourceType: SearchSourceType): string {
  switch (sourceType) {
    case 'note_chunk': return 'Note section';
    case 'copy_block': return 'Copy block';
    case 'code_block': return 'Code';
    case 'attachment_chunk': return 'Attachment';
    case 'note_metadata': return 'Note';
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const element = document.createElement('textarea');
  element.value = value; element.style.position = 'fixed'; element.style.opacity = '0';
  document.body.append(element); element.select();
  if (!document.execCommand('copy')) throw new Error('Clipboard access was unavailable.');
  element.remove();
}

export function SearchPanel({
  onSearchStateChange, notebookId = null, unfiled = false, selectedNotebookId, notebooks = [], availableTags = [],
  initialQuery = '', initialTag = '', initialSource = '', onNotebookChange, onSearchParamsChange, onResultSelect,
}: SearchPanelProps): JSX.Element {
  const { toast } = useToast();
  const { session } = useAuth();
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  const [tagFilter, setTagFilter] = useState(initialTag);
  const [sourceFilter, setSourceFilter] = useState<SearchSourceType | ''>(initialSource);
  const [localResponse, setLocalResponse] = useState<SearchResponse | null>(null);
  const [blockedAttachmentUrls, setBlockedAttachmentUrls] = useState<Record<string, string>>({});
  const tags = useMemo(() => [...new Set(availableTags)].sort((left, right) => left.localeCompare(right)), [availableTags]);
  const filters = useMemo(() => {
    const value: SearchFilters = {};
    if (notebookId) value.notebookIds = [notebookId];
    if (tagFilter) value.tags = [tagFilter];
    if (sourceFilter) value.sourceTypes = [sourceFilter];
    if (unfiled) value.unfiled = true;
    return value;
  }, [notebookId, sourceFilter, tagFilter, unfiled]);

  useEffect(() => setQuery(initialQuery), [initialQuery]);
  useEffect(() => setDebounced(initialQuery.trim()), [initialQuery]);
  useEffect(() => setTagFilter(initialTag), [initialTag]);
  useEffect(() => setSourceFilter(initialSource), [initialSource]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let active = true;
    if (!query.trim()) { setLocalResponse(null); return () => { active = false; }; }
    void localMatches(query, filters, userId).then((notes) => { if (active) setLocalResponse(localSearchResponse(notes)); }).catch(() => { if (active) setLocalResponse(null); });
    return () => { active = false; };
  }, [filters, query, userId]);
  useEffect(() => {
    onSearchParamsChange?.({ q: debounced || undefined, documentId: undefined, blockKey: undefined, attachmentId: undefined }, { replace: true });
  }, [debounced, onSearchParamsChange]);

  const result = useInfiniteQuery({
    queryKey: queryKeys.search(debounced, filters, 20, 2), initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await api.searchPost({ query: debounced, mode: 'auto', limit: 20, maxPerNote: 2, filters, ...(pageParam ? { cursor: pageParam } : {}) }, { signal });
      } catch (error: unknown) {
        if (!pageParam && isTransientSearchError(error)) return localSearchResponse(await localMatches(debounced, filters, userId));
        throw error;
      }
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined, enabled: Boolean(debounced && session), staleTime: 30_000, retry: false,
  });
  const pages = result.data?.pages ?? [];
  const firstPage = pages[0];
  const lastPage = pages.at(-1);
  const serverResponse = firstPage ? { ...firstPage, items: pages.flatMap((page) => page.items), nextCursor: lastPage?.nextCursor ?? null } : null;
  const displayResponse = query.trim() !== debounced ? localResponse : serverResponse ?? (result.error && isTransientSearchError(result.error) ? localResponse : null);

  useEffect(() => {
    onSearchStateChange?.({ query: debounced, response: displayResponse, scopeKey: `${notebookId ?? ''}:${unfiled}:${tagFilter}:${sourceFilter}` });
  }, [debounced, displayResponse, notebookId, onSearchStateChange, sourceFilter, tagFilter, unfiled]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = query.trim(); setDebounced(nextQuery);
    onSearchParamsChange?.({ q: nextQuery || undefined, documentId: undefined, blockKey: undefined, attachmentId: undefined }, { replace: false });
  };
  const changeTag = (value: string) => { const next = value.trim().toLowerCase(); setTagFilter(next); onSearchParamsChange?.({ tag: next || undefined, documentId: undefined, blockKey: undefined, attachmentId: undefined }, { replace: false }); };
  const changeSource = (value: SearchSourceType | '') => { setSourceFilter(value); onSearchParamsChange?.({ source: value || undefined, documentId: undefined, blockKey: undefined, attachmentId: undefined }, { replace: false }); };
  const clearFilters = () => { setTagFilter(''); setSourceFilter(''); onNotebookChange?.(null); onSearchParamsChange?.({ tag: undefined, source: undefined, documentId: undefined, blockKey: undefined, attachmentId: undefined }, { replace: false }); };
  const matchingNoteCount = new Set(displayResponse?.items.map((item) => item.noteId)).size;
  const hasFilters = Boolean(tagFilter || sourceFilter || notebookId || unfiled);
  const selectResult = (item: SearchResult) => {
    if (displayResponse) void rememberSearchSelection({ queryId: displayResponse.queryId, documentId: item.documentId ?? item.id, selectedAt: new Date().toISOString() }, userId).catch(() => { toast('Search history could not be saved locally.', 'info'); });
    onResultSelect?.(item);
  };
  const copyBlock = async (item: SearchResult) => {
    if (!item.blockKey) return;
    try {
      const [currentNote, block] = await Promise.all([api.getNote(item.noteId), api.getBlock(item.noteId, item.blockKey)]);
      await copyText(block.content);
      toast(currentNote.version !== item.noteVersion ? 'Copied the current block; this note changed since the result was indexed.' : 'Block copied.', 'success');
    } catch (error: unknown) {
      toast(error instanceof QNotesHttpError && error.status === 404 ? 'That block moved or was deleted. Open the matching section to review the current note.' : 'Unable to copy the current block.', 'error');
    }
  };
  const openAttachment = async (item: SearchResult) => {
    if (!item.attachmentId) return;
    try {
      const resultUrl = await api.getAttachmentDownloadUrl(item.attachmentId);
      const opened = window.open(resultUrl.signedUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        setBlockedAttachmentUrls((current) => ({ ...current, [item.id]: resultUrl.signedUrl }));
        toast('Your browser blocked the attachment window. Use the temporary link beside the result.', 'info');
      }
    } catch { toast('Unable to open this private attachment.', 'error'); }
  };
  const statusText = !debounced ? null
    : result.isPending && !displayResponse ? 'Searching your full workspace…'
      : result.error && !displayResponse ? 'Full search is unavailable right now. Try again in a moment.'
        : result.error && displayResponse ? 'Showing recent local matches; full search is unavailable.'
          : serverResponse?.degradedReason === 'LOCAL_FALLBACK' ? 'Showing recent local matches; full search is unavailable.'
            : serverResponse?.degraded ? 'Showing keyword matches; semantic retrieval is temporarily unavailable.'
            : result.isFetching && displayResponse ? 'Refreshing full-workspace results…'
              : displayResponse?.items.length ? `${displayResponse.items.length} matches across ${matchingNoteCount} ${matchingNoteCount === 1 ? 'note' : 'notes'}`
                : 'No matches yet. Try a shorter phrase or reset the filters.';

  return <section className="q-search-panel" aria-label="Search notes" aria-busy={result.isFetching}>
    <form className="q-search-large q-mobile-search" onSubmit={submit}><Search size={19} aria-hidden="true" /><input id="global-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your notes, blocks, and attachments…" aria-label="Search notes" /><span className="q-search-kbd" aria-label={`Keyboard shortcut ${searchShortcutLabel()}`}>{searchShortcutLabel()}</span></form>
    <div className="q-search-options">
      {notebooks.length > 0 && <label><span className="q-label">Notebook</span><select aria-label="Filter search by notebook" value={selectedNotebookId ?? ''} onChange={(event) => onNotebookChange?.(event.target.value || null)}><option value="">All notebooks</option><option value={UNFILED_SEARCH_NOTEBOOK}>Unfiled</option>{notebooks.map((notebook) => <option value={notebook.id} key={notebook.id}>{notebook.name}</option>)}</select></label>}
      <label><span className="q-label">Tag</span><input className="q-search-filter-input" aria-label="Filter search by tag" list="known-note-tags" value={tagFilter} onChange={(event) => changeTag(event.target.value)} placeholder="Any tag" maxLength={MAX_TAG_LENGTH} /><datalist id="known-note-tags">{tags.map((tag) => <option value={tag} key={tag} />)}</datalist></label>
      <label><span className="q-label">Source</span><select aria-label="Filter search by source" value={sourceFilter} onChange={(event) => changeSource(event.target.value as SearchSourceType | '')}><option value="">All sources</option><option value="note_chunk">Note sections</option><option value="code_block">Code</option><option value="copy_block">Copy blocks</option><option value="attachment_chunk">Attachments</option></select></label>
      {hasFilters && <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>Reset filters</Button>}
    </div>
    {statusText && <p className="q-search-status" role="status">{statusText}{displayResponse?.index && !displayResponse.index.fresh && !result.error ? ' Indexing is still catching up.' : ''}{result.error && <Button type="button" variant="ghost" size="sm" onClick={() => void result.refetch()}>Retry</Button>}</p>}
    {debounced && displayResponse && displayResponse.items.length > 0 && <ul className="q-search-results" aria-label="Matched search results">
      {displayResponse.items.map((item) => <li key={`${item.id}:${item.documentId ?? ''}:${item.sourceKey}`}><article className="q-search-result">
        <button type="button" className="q-search-result-main" onClick={() => selectResult(item)}><span className="q-search-result-heading"><strong>{item.noteTitle}</strong><span className="q-search-result-type">{sourceLabel(item.sourceType)}</span></span><span className="q-search-result-context">{item.headingPath ?? item.sourceTitle}{item.noteVersion ? ` · version ${item.noteVersion}` : ''}</span><small>{item.snippet}</small></button>
        <div className="q-search-result-details"><span>{item.notebookId ? 'Notebook note' : 'Unfiled note'}{item.language ? ` · ${item.language}` : ''}{item.attachmentId ? ` · ${item.sourceTitle}` : ''}</span><div className="q-search-result-actions">
          {item.copyable && <Button type="button" variant="ghost" size="sm" onClick={() => void copyBlock(item)}>Copy {item.sourceType === 'code_block' ? 'command' : 'block'}</Button>}
          {item.sourceType === 'attachment_chunk' && item.attachmentId && <Button type="button" variant="ghost" size="sm" onClick={() => void openAttachment(item)}>Open file</Button>}
          <Button type="button" variant="outline" size="sm" onClick={() => selectResult(item)}>Open matching section</Button>
          {blockedAttachmentUrls[item.id] && <a className="q-search-temporary-link" href={blockedAttachmentUrls[item.id]} target="_blank" rel="noreferrer">Open temporary file link</a>}
        </div></div>
      </article></li>)}
    </ul>}
    {debounced && result.hasNextPage && <Button type="button" variant="outline" onClick={() => void result.fetchNextPage()} disabled={result.isFetchingNextPage}>{result.isFetchingNextPage ? 'Loading more results…' : 'Load more results'}</Button>}
  </section>;
}
