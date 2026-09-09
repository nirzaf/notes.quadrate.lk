import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import type { NoteSummary } from '@qnotes/shared';
import { api } from '../api';
import { getDeviceId } from '../indexed-db';
import { AppShell } from '../components/app-shell';
import { Button } from '../components/ui/button';
import { useToast } from '../components/ui/toast';
import { noteQueryKeys, refreshNoteCollections } from '../note-query-keys';
import { useAuth } from '../auth-context';

export function TrashPage(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const { toast } = useToast();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const sidebarQuery = useQuery({ queryKey: queryKeys.sidebar, queryFn: ({ signal }) => api.listNotes({ limit: 50, signal }), enabled: Boolean(session) });
  const trashQuery = useInfiniteQuery({
    queryKey: queryKeys.trash(50),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.listNotes({ limit: 50, deletedOnly: true, ...(pageParam ? { cursor: pageParam } : {}), signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(session),
  });
  const restore = async (noteId: string, version: number) => {
    if (restoringId) return;
    setRestoringId(noteId);
    try {
      await api.restoreNote(noteId, { expectedVersion: version, deviceId: getDeviceId(), mutationId: crypto.randomUUID() });
      await refreshNoteCollections(queryClient, userId);
      toast('Note restored.', 'success');
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : 'Unable to restore note.', 'error');
    } finally {
      setRestoringId(null);
    }
  };
  const notes = useMemo(() => {
    const unique = new Map<string, NoteSummary>();
    for (const note of trashQuery.data?.pages.flatMap((page) => page.items) ?? []) unique.set(note.id, note);
    return [...unique.values()];
  }, [trashQuery.data?.pages]);
  return <AppShell title="Trash" notes={sidebarQuery.data?.items ?? []} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id } })}>
    <div className="q-main-body">
      <section className="q-card q-card-pad q-trash" aria-labelledby="trash-heading">
        <div className="q-section-heading"><div><p className="q-eyebrow">Recovery</p><h2 id="trash-heading">Trash</h2></div><span className="q-small">{notes.length} loaded</span></div>
        {trashQuery.isLoading ? <div className="q-empty">Loading Trash…</div> : trashQuery.error ? <div className="q-error" role="alert">Unable to load Trash right now. Please try again. <Button type="button" variant="outline" size="sm" onClick={() => void trashQuery.refetch()}>Retry</Button></div> : notes.length === 0 ? <div className="q-empty">Trash is empty.</div> : <><div className="q-trash-list">{notes.map((note) => <article className="q-trash-item" key={note.id}><div><Link to="/notes/$noteId" params={{ noteId: note.id }} className="q-trash-title">{note.title}</Link><p className="q-note-item-excerpt">{note.excerpt || 'Empty note'}</p><span className="q-small">Deleted {note.deletedAt ? new Date(note.deletedAt).toLocaleDateString() : 'recently'}</span></div><Button variant="secondary" size="sm" onClick={() => void restore(note.id, note.version)} disabled={restoringId !== null}><RotateCcw size={15} aria-hidden="true" />Restore</Button></article>)}</div>{trashQuery.hasNextPage ? <Button variant="outline" onClick={() => void trashQuery.fetchNextPage()} disabled={trashQuery.isFetchingNextPage}>{trashQuery.isFetchingNextPage ? 'Loading more…' : 'Load more deleted notes'}</Button> : null}</>}
      </section>
    </div>
  </AppShell>;
}
