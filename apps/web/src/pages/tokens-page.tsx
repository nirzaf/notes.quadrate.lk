import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api';
import { AppShell } from '../components/app-shell';
import { TokenManager } from '../components/token-manager';
import { noteQueryKeys } from '../note-query-keys';
import { useAuth } from '../auth-context';

export function TokensPage(): JSX.Element {
  const navigate = useNavigate();
  const { session } = useAuth();
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const notesQuery = useQuery({ queryKey: queryKeys.sidebar, queryFn: ({ signal }) => api.listNotes({ limit: 50, signal }), enabled: Boolean(session) });
  return <AppShell title="Integrations" notes={notesQuery.data?.items ?? []} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id } })}><div className="q-main-body"><div className="q-working-header"><div><p className="q-eyebrow">For scripts and agents</p><h2>Connect tools to your notes.</h2><p className="q-subtitle">Create a narrowly scoped Hermes connection, verify the API token, then verify the real local MCP round trip from your terminal.</p></div></div><div style={{ marginTop: 28 }}><TokenManager /></div></div></AppShell>;
}
