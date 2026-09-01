import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api';
import { AppShell } from '../components/app-shell';
import { TokenManager } from '../components/token-manager';

export function TokensPage(): JSX.Element {
  const navigate = useNavigate();
  const notesQuery = useQuery({ queryKey: ['notes'], queryFn: () => api.listNotes({ limit: 500 }) });
  return <AppShell title="Personal API tokens" notes={notesQuery.data?.items ?? []} onNew={() => void navigate({ to: '/' })} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id } })}><div className="q-main-body"><p className="q-eyebrow">For scripts and agents</p><h2 className="q-display" style={{ fontSize: 'clamp(2.3rem, 6vw, 4.4rem)' }}>A safe bridge<br />to your notes.</h2><p className="q-subtitle">Create narrowly scoped personal tokens for the CLI. Tokens are hashed server-side and shown in full only once.</p><div style={{ marginTop: 28 }}><TokenManager /></div></div></AppShell>;
}
