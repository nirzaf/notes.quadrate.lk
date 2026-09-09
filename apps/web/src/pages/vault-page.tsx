import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { VaultAgentGrant, VaultSecretMetadata } from '@qnotes/shared';
import { MAX_VAULT_DESCRIPTION_LENGTH, MAX_VAULT_ENVIRONMENT_NAME_LENGTH, MAX_VAULT_PROJECT_NAME_LENGTH, MAX_VAULT_SECRET_BYTES, MAX_VAULT_SECRET_NAME_LENGTH } from '@qnotes/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { vaultApi, api } from '../api';
import { AppShell } from '../components/app-shell';
import { Button } from '../components/ui/button';
import { useAuth } from '../auth-context';
import { noteQueryKeys } from '../note-query-keys';
import { useToast } from '../components/ui/toast';

type VaultSection = 'vault' | 'agents' | 'audit';
type GrantScope = 'project' | 'environment' | 'secret';
type TokenExpiry = 'never' | '7d' | '30d' | '90d' | '365d';
type VaultProject = Awaited<ReturnType<typeof vaultApi.listProjects>>[number];
type VaultEnvironment = Awaited<ReturnType<typeof vaultApi.listEnvironments>>[number];
type VaultToken = Awaited<ReturnType<typeof vaultApi.listAgentTokens>>[number];
type VaultAuditEvent = Awaited<ReturnType<typeof vaultApi.listAudit>>[number];
type VaultListQuery<T> = Pick<UseQueryResult<T[]>, 'data' | 'isPending' | 'isError' | 'isFetching' | 'refetch'>;
type VaultProjectsQuery = VaultListQuery<VaultProject>;
type VaultEnvironmentsQuery = VaultListQuery<VaultEnvironment>;
type VaultSecretsQuery = VaultListQuery<VaultSecretMetadata>;
type VaultTokensQuery = VaultListQuery<VaultToken>;
type VaultAuditQuery = VaultListQuery<VaultAuditEvent>;
type RevealedSecret = { environmentId: string; id: string; value: string };

const tokenExpiryOptions: Array<{ value: TokenExpiry; label: string; days?: number }> = [
  { value: 'never', label: 'Never' },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
  { value: '365d', label: '365 days', days: 365 },
];

function tokenExpiresAt(choice: TokenExpiry): string | null {
  const days = tokenExpiryOptions.find((option) => option.value === choice)?.days;
  return days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;
}

function sectionForPath(pathname: string): VaultSection {
  if (pathname === '/vault/agents') return 'agents';
  if (pathname === '/vault/audit') return 'audit';
  return 'vault';
}

function safeErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}

function VaultLoadingState({ resource }: { resource: string }): JSX.Element {
  return <p className="q-empty q-vault-state" role="status" aria-live="polite">Loading {resource}…</p>;
}

function VaultEmptyState({ message }: { message: string }): JSX.Element {
  return <p className="q-empty q-vault-state" role="status" aria-live="polite">{message}</p>;
}

function VaultErrorState({ resource, onRetry, retrying = false }: { resource: string; onRetry: () => Promise<unknown>; retrying?: boolean }): JSX.Element {
  return <div className="q-error q-vault-state" role="alert"><span>Unable to load {resource}. Vault values and response details are hidden.</span><Button type="button" size="sm" variant="outline" onClick={() => void onRetry()} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry'}</Button></div>;
}

function VaultCollectionState<T>({ query, resource, emptyMessage, children }: { query: VaultListQuery<T>; resource: string; emptyMessage: string; children: (items: T[]) => JSX.Element }): JSX.Element {
  if (query.isPending && !query.data) return <VaultLoadingState resource={resource} />;
  if (query.isError) return <VaultErrorState resource={resource} onRetry={query.refetch} retrying={query.isFetching} />;
  if (!query.data?.length) return <VaultEmptyState message={emptyMessage} />;
  return children(query.data);
}

function VaultQueryStatus<T>({ query, resource, emptyMessage }: { query: VaultListQuery<T>; resource: string; emptyMessage: string }): JSX.Element | null {
  if (query.isPending && !query.data) return <VaultLoadingState resource={resource} />;
  if (query.isError) return <VaultErrorState resource={resource} onRetry={query.refetch} retrying={query.isFetching} />;
  if (!query.data?.length) return <VaultEmptyState message={emptyMessage} />;
  return null;
}

function grantScope(grant: VaultAgentGrant): GrantScope {
  if (grant.secretId) return 'secret';
  if (grant.environmentId) return 'environment';
  return 'project';
}

function grantActionLabel(action: VaultAgentGrant['action']): string {
  return { 'metadata:read': 'Metadata read', 'secret:reveal': 'Secret reveal', 'secret:write': 'Secret write', 'secret:delete': 'Secret delete' }[action];
}

function grantScopeLabel(grant: VaultAgentGrant, projects: VaultProject[], environments: VaultEnvironment[], secrets: VaultSecretMetadata[]): string {
  const project = projects.find((item) => item.id === grant.projectId);
  const environment = environments.find((item) => item.id === grant.environmentId);
  const secret = secrets.find((item) => item.id === grant.secretId);
  if (grantScope(grant) === 'secret') return `Secret · ${grant.secretName ?? secret?.name ?? grant.secretId}`;
  if (grantScope(grant) === 'environment') return `Environment · ${grant.environmentName ?? environment?.name ?? grant.environmentId}`;
  return `Project · ${grant.projectName ?? project?.name ?? grant.projectId}`;
}

function grantTargetLabel(grant: VaultAgentGrant, projects: VaultProject[], environments: VaultEnvironment[]): string {
  const project = projects.find((item) => item.id === grant.projectId);
  const environment = environments.find((item) => item.id === grant.environmentId);
  const projectName = grant.projectName ?? project?.name ?? grant.projectId;
  const environmentName = grant.environmentName ?? environment?.name ?? grant.environmentId;
  return grantScope(grant) === 'secret'
    ? `${projectName} / ${environmentName}`
    : grantScope(grant) === 'environment' ? `Project: ${projectName}` : `All environments and secrets in ${projectName}`;
}

export function VaultPage(): JSX.Element {
  const { session } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const section = sectionForPath(location.pathname);
  const userId = session?.user.id ?? 'unauthenticated';
  const queryKeys = useMemo(() => noteQueryKeys.forUser(userId), [userId]);
  const notesQuery = useQuery({ queryKey: queryKeys.sidebar, queryFn: ({ signal }) => api.listNotes({ limit: 50, signal }), enabled: Boolean(session) });
  const projectsQuery = useQuery({ queryKey: ['qvault', userId, 'projects'], queryFn: ({ signal }) => vaultApi.listProjects({ signal }), enabled: Boolean(session) });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const selectedProject = projectsQuery.data?.find((project) => project.id === projectId) ?? projectsQuery.data?.[0];
  const environmentsQuery = useQuery({ queryKey: ['qvault', userId, 'environments', selectedProject?.id], queryFn: ({ signal }) => vaultApi.listEnvironments(selectedProject!.id, { signal }), enabled: Boolean(selectedProject) && (section === 'vault' || section === 'agents') });
  const selectedEnvironment = environmentsQuery.data?.find((environment) => environment.id === environmentId) ?? environmentsQuery.data?.[0];
  const secretsQuery = useQuery({ queryKey: ['qvault', userId, 'secrets', selectedEnvironment?.id], queryFn: ({ signal }) => vaultApi.listSecrets(selectedEnvironment!.id, { signal }), enabled: Boolean(selectedEnvironment) && (section === 'vault' || section === 'agents') });
  const tokensQuery = useQuery({ queryKey: ['qvault', userId, 'agent-tokens'], queryFn: ({ signal }) => vaultApi.listAgentTokens({ signal }), enabled: Boolean(session) && section === 'agents' });
  const auditQuery = useQuery({ queryKey: ['qvault', userId, 'audit'], queryFn: ({ signal }) => vaultApi.listAudit({ signal }), enabled: Boolean(session) && section === 'audit' });

  const [projectName, setProjectName] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [environmentName, setEnvironmentName] = useState('');
  const [environmentSlug, setEnvironmentSlug] = useState('');
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretDescription, setSecretDescription] = useState('');
  const [changeSecretId, setChangeSecretId] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<RevealedSecret | null>(null);
  const revealAttempt = useRef(0);
  const [tokenName, setTokenName] = useState('');
  const [tokenScope, setTokenScope] = useState<GrantScope>('project');
  const [tokenSecretId, setTokenSecretId] = useState<string | null>(null);
  const [tokenAction, setTokenAction] = useState<VaultAgentGrant['action']>('metadata:read');
  const [tokenExpiry, setTokenExpiry] = useState<TokenExpiry>('never');
  const [draftGrants, setDraftGrants] = useState<VaultAgentGrant[]>([]);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingGrants, setEditingGrants] = useState<VaultAgentGrant[]>([]);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projectId && projectsQuery.data?.some((project) => project.id === projectId)) return;
    setProjectId(projectsQuery.data?.[0]?.id ?? null);
  }, [projectId, projectsQuery.data]);

  useEffect(() => {
    if (environmentId && environmentsQuery.data?.some((environment) => environment.id === environmentId)) return;
    setEnvironmentId(environmentsQuery.data?.[0]?.id ?? null);
  }, [environmentId, environmentsQuery.data]);

  useEffect(() => {
    revealAttempt.current += 1;
    setRevealedSecret(null);
    setChangeSecretId(null);
    setSecretValue('');
  }, [selectedEnvironment?.id, section]);

  useEffect(() => {
    if (tokenSecretId && secretsQuery.data?.some((secret) => secret.id === tokenSecretId)) return;
    setTokenSecretId(null);
  }, [selectedEnvironment?.id, secretsQuery.data, tokenSecretId]);

  useEffect(() => () => {
    revealAttempt.current += 1;
    setRevealedSecret(null);
  }, []);

  useEffect(() => {
    setIssuedToken(null);
  }, [section]);

  useEffect(() => {
    if (!revealedSecret) return;
    const timer = window.setTimeout(() => setRevealedSecret(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [revealedSecret]);

  const selectProject = (id: string) => {
    revealAttempt.current += 1;
    setRevealedSecret(null);
    setProjectId(id);
  };

  const selectEnvironment = (id: string) => {
    revealAttempt.current += 1;
    setRevealedSecret(null);
    setEnvironmentId(id);
  };

  const refreshProjects = async () => { await projectsQuery.refetch(); };
  const refreshSecrets = async () => { await secretsQuery.refetch(); };

  const createProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const project = await vaultApi.createProject({ name: projectName, ...(projectSlug ? { slug: projectSlug } : {}), ...(projectDescription ? { description: projectDescription } : {}) });
      setProjectName(''); setProjectSlug(''); setProjectDescription('');
      await refreshProjects(); selectProject(project.id); toast('Vault project created.', 'success');
    } catch (error: unknown) { toast(safeErrorMessage(error, 'Unable to create Vault project.'), 'error'); }
    finally { setBusy(false); }
  };

  const createEnvironment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProject) return;
    setBusy(true);
    try {
      const environment = await vaultApi.createEnvironment(selectedProject.id, { name: environmentName, ...(environmentSlug ? { slug: environmentSlug } : {}) });
      setEnvironmentName(''); setEnvironmentSlug(''); await environmentsQuery.refetch(); selectEnvironment(environment.id); toast('Vault environment created.', 'success');
    } catch (error: unknown) { toast(safeErrorMessage(error, 'Unable to create Vault environment.'), 'error'); }
    finally { setBusy(false); }
  };

  const saveSecret = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProject || !selectedEnvironment) return;
    setBusy(true);
    try {
      if (changeSecretId) {
        const current = secretsQuery.data?.find((secret) => secret.id === changeSecretId);
        if (!current) throw new Error('Select an active Vault secret before rotating it.');
        await vaultApi.rotateSecret(current.id, { value: secretValue, expectedVersion: current.version, mutationId: crypto.randomUUID(), ...(secretDescription ? { description: secretDescription } : {}) });
        toast('Vault secret rotated.', 'success');
      } else {
        await vaultApi.createSecret({ projectId: selectedProject.id, environmentId: selectedEnvironment.id, name: secretName, value: secretValue, mutationId: crypto.randomUUID(), ...(secretDescription ? { description: secretDescription } : {}) });
        toast('Vault secret created.', 'success');
      }
      setSecretName(''); setSecretValue(''); setSecretDescription(''); setChangeSecretId(null); await refreshSecrets();
    } catch (error: unknown) { toast(safeErrorMessage(error, 'Unable to save Vault secret.'), 'error'); }
    finally { setBusy(false); }
  };

  const reveal = async (secret: VaultSecretMetadata) => {
    if (!selectedProject || !selectedEnvironment) return;
    const attempt = revealAttempt.current + 1;
    revealAttempt.current = attempt;
    setRevealedSecret(null);
    try {
      const result = await vaultApi.revealSecret({ project: selectedProject.slug, environment: selectedEnvironment.slug, name: secret.name, purpose: 'Manual reveal in the QNotes Vault administration UI' });
      if (attempt !== revealAttempt.current) return;
      setRevealedSecret({ environmentId: selectedEnvironment.id, id: secret.id, value: result.value });
    } catch (error: unknown) {
      if (attempt !== revealAttempt.current) return;
      setRevealedSecret(null);
      toast(safeErrorMessage(error, 'Unable to reveal Vault secret. The value remains hidden.'), 'error');
    }
  };

  const removeSecret = async (secret: VaultSecretMetadata) => {
    if (!window.confirm(`Delete ${secret.name}? This removes the encrypted Vault value.`)) return;
    setBusy(true);
    try { await vaultApi.deleteSecret(secret.id, { expectedVersion: secret.version, mutationId: crypto.randomUUID(), confirm: true }); await refreshSecrets(); toast('Vault secret deleted.', 'success'); }
    catch (error: unknown) { toast(safeErrorMessage(error, 'Unable to delete Vault secret.'), 'error'); }
    finally { setBusy(false); }
  };

  const createAgentToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftGrants.length) { toast('Add at least one grant before creating a Vault agent token.', 'error'); return; }
    setBusy(true);
    try {
      const result = await vaultApi.createAgentToken({ name: tokenName, expiresAt: tokenExpiresAt(tokenExpiry), grants: draftGrants });
      setTokenName(''); setDraftGrants([]); setIssuedToken(result.token); await tokensQuery.refetch(); toast('Vault agent token created. Copy it now; it is shown only once.', 'success');
    } catch (error: unknown) { toast(safeErrorMessage(error, 'Unable to create Vault agent token.'), 'error'); }
    finally { setBusy(false); }
  };

  const buildSelectedGrant = (): VaultAgentGrant | null => {
    if (!selectedProject) { toast('Select a project before adding a grant.', 'error'); return null; }
    const grant: VaultAgentGrant = { projectId: selectedProject.id, environmentId: tokenScope === 'project' ? null : selectedEnvironment?.id ?? null, secretId: tokenScope === 'secret' ? tokenSecretId : null, action: tokenAction };
    if (tokenScope !== 'project' && !grant.environmentId) { toast('Select an environment before adding this scoped grant.', 'error'); return null; }
    if (tokenScope === 'secret' && !grant.secretId) { toast('Select a secret before adding a secret-scoped grant.', 'error'); return null; }
    return grant;
  };

  const addGrant = (target: 'draft' | 'editing') => {
    const grant = buildSelectedGrant();
    if (!grant) return;
    const current = target === 'draft' ? draftGrants : editingGrants;
    if (current.some((item) => item.projectId === grant.projectId && item.environmentId === grant.environmentId && item.secretId === grant.secretId && item.action === grant.action)) {
      toast('That grant is already in the set.', 'error');
      return;
    }
    if (target === 'draft') setDraftGrants((items) => [...items, grant]);
    else setEditingGrants((items) => [...items, grant]);
  };

  const beginEditingToken = (token: VaultToken) => {
    setEditingTokenId(token.id);
    setEditingGrants(token.grants);
  };

  const replaceAgentGrants = async () => {
    if (!editingTokenId) return;
    setBusy(true);
    try {
      await vaultApi.replaceAgentGrants(editingTokenId, editingGrants);
      await tokensQuery.refetch();
      setEditingTokenId(null);
      setEditingGrants([]);
      toast('Vault agent grants replaced.', 'success');
    } catch (error: unknown) { toast(safeErrorMessage(error, 'Unable to replace Vault agent grants.'), 'error'); }
    finally { setBusy(false); }
  };

  const copyIssuedToken = async () => { if (issuedToken) { await navigator.clipboard?.writeText(issuedToken); toast('Token copied. It will not be read back by QNotes.', 'success'); } };
  const copyRevealedSecret = async () => { if (revealedSecret) { await navigator.clipboard?.writeText(revealedSecret.value); toast('Secret copied. QNotes does not read the clipboard.', 'success'); } };

  const content = section === 'agents' ? <AgentsPanel projectsQuery={projectsQuery} selectedProject={selectedProject} onProjectSelect={selectProject} environmentsQuery={environmentsQuery} selectedEnvironment={selectedEnvironment} onEnvironmentSelect={selectEnvironment} secretsQuery={secretsQuery} tokenSecretId={tokenSecretId} setTokenSecretId={setTokenSecretId} tokenName={tokenName} setTokenName={setTokenName} tokenScope={tokenScope} setTokenScope={setTokenScope} tokenAction={tokenAction} setTokenAction={setTokenAction} tokenExpiry={tokenExpiry} setTokenExpiry={setTokenExpiry} draftGrants={draftGrants} editingTokenId={editingTokenId} editingGrants={editingGrants} onAddGrant={addGrant} onRemoveDraftGrant={(index) => setDraftGrants((items) => items.filter((_, itemIndex) => itemIndex !== index))} onRemoveEditingGrant={(index) => setEditingGrants((items) => items.filter((_, itemIndex) => itemIndex !== index))} onSubmit={createAgentToken} onBeginEdit={beginEditingToken} onCancelEdit={() => { setEditingTokenId(null); setEditingGrants([]); }} onReplace={replaceAgentGrants} busy={busy} tokensQuery={tokensQuery} issuedToken={issuedToken} closeIssuedToken={() => setIssuedToken(null)} copyIssuedToken={() => void copyIssuedToken()} onRevoke={async (id) => { await vaultApi.revokeAgentToken(id); await tokensQuery.refetch(); toast('Vault agent token revoked.', 'success'); }} />
    : section === 'audit' ? <AuditPanel query={auditQuery} />
      : <VaultWorkspace projectsQuery={projectsQuery} selectedProject={selectedProject} onProjectSelect={selectProject} projectName={projectName} setProjectName={setProjectName} projectSlug={projectSlug} setProjectSlug={setProjectSlug} projectDescription={projectDescription} setProjectDescription={setProjectDescription} onCreateProject={createProject} environmentsQuery={environmentsQuery} selectedEnvironment={selectedEnvironment} onEnvironmentSelect={selectEnvironment} environmentName={environmentName} setEnvironmentName={setEnvironmentName} environmentSlug={environmentSlug} setEnvironmentSlug={setEnvironmentSlug} onCreateEnvironment={createEnvironment} secretsQuery={secretsQuery} secretName={secretName} setSecretName={setSecretName} secretValue={secretValue} setSecretValue={setSecretValue} secretDescription={secretDescription} setSecretDescription={setSecretDescription} changeSecretId={changeSecretId} setChangeSecretId={setChangeSecretId} onSaveSecret={saveSecret} onReveal={reveal} revealedSecret={revealedSecret} onHide={() => setRevealedSecret(null)} onCopy={copyRevealedSecret} onDelete={removeSecret} busy={busy} />;

  return <AppShell title="Agent Vault" notes={notesQuery.data?.items ?? []} onSelectNote={(id) => void navigate({ to: '/notes/$noteId', params: { noteId: id } })}><div className="q-main-body"><div className="q-working-header"><div><p className="q-eyebrow">Private context + credentials</p><h2>Agent Vault</h2><p className="q-subtitle">Organize deployment secrets separately from Notes. Values stay masked until you deliberately reveal or rotate one.</p></div></div><nav className="q-vault-tabs" aria-label="Vault administration"><Link to="/vault" data-active={section === 'vault'} aria-current={section === 'vault' ? 'page' : undefined}>Projects</Link><Link to="/vault/agents" data-active={section === 'agents'} aria-current={section === 'agents' ? 'page' : undefined}>Agent tokens</Link><Link to="/vault/audit" data-active={section === 'audit'} aria-current={section === 'audit' ? 'page' : undefined}>Audit</Link></nav>{content}</div></AppShell>;
}

type VaultWorkspaceProps = {
  projectsQuery: VaultProjectsQuery;
  selectedProject: VaultProject | undefined;
  onProjectSelect: (id: string) => void;
  projectName: string;
  setProjectName: (value: string) => void;
  projectSlug: string;
  setProjectSlug: (value: string) => void;
  projectDescription: string;
  setProjectDescription: (value: string) => void;
  onCreateProject: (event: React.FormEvent<HTMLFormElement>) => void;
  environmentsQuery: VaultEnvironmentsQuery;
  selectedEnvironment: VaultEnvironment | undefined;
  onEnvironmentSelect: (id: string) => void;
  environmentName: string;
  setEnvironmentName: (value: string) => void;
  environmentSlug: string;
  setEnvironmentSlug: (value: string) => void;
  onCreateEnvironment: (event: React.FormEvent<HTMLFormElement>) => void;
  secretsQuery: VaultSecretsQuery;
  secretName: string;
  setSecretName: (value: string) => void;
  secretValue: string;
  setSecretValue: (value: string) => void;
  secretDescription: string;
  setSecretDescription: (value: string) => void;
  changeSecretId: string | null;
  setChangeSecretId: (value: string | null) => void;
  onSaveSecret: (event: React.FormEvent<HTMLFormElement>) => void;
  onReveal: (secret: VaultSecretMetadata) => void;
  revealedSecret: RevealedSecret | null;
  onHide: () => void;
  onCopy: () => void;
  onDelete: (secret: VaultSecretMetadata) => void;
  busy: boolean;
};

function EnvironmentCreateForm(props: Pick<VaultWorkspaceProps, 'environmentName' | 'setEnvironmentName' | 'environmentSlug' | 'setEnvironmentSlug' | 'onCreateEnvironment'>): JSX.Element {
  return <form className="q-vault-inline-form" onSubmit={props.onCreateEnvironment}><input className="q-input" required maxLength={MAX_VAULT_ENVIRONMENT_NAME_LENGTH} value={props.environmentName} onChange={(event) => props.setEnvironmentName(event.target.value)} placeholder="New environment" aria-label="New environment name" /><input className="q-input" maxLength={80} value={props.environmentSlug} onChange={(event) => props.setEnvironmentSlug(event.target.value)} placeholder="slug" aria-label="New environment slug" /><Button type="submit" size="sm">Add</Button></form>;
}

function VaultWorkspace(props: VaultWorkspaceProps): JSX.Element {
  const projects = props.projectsQuery.data ?? [];
  const secrets = props.secretsQuery.data ?? [];
  const dependentEnvironmentState = !props.selectedProject
    ? props.projectsQuery.isPending ? <VaultLoadingState resource="Vault environments after projects load" />
      : props.projectsQuery.isError ? <VaultErrorState resource="Vault environments" onRetry={props.projectsQuery.refetch} retrying={props.projectsQuery.isFetching} />
        : <VaultEmptyState message="No Vault environments are available until you create a project." />
    : null;

  return <div className="q-vault-grid">
    <section className="q-card q-card-pad">
      <div className="q-section-heading"><div className="q-section-heading-main"><h2>Projects</h2><span className="q-count-badge">{props.projectsQuery.data ? projects.length : '—'}</span></div></div>
      <VaultCollectionState query={props.projectsQuery} resource="Vault projects" emptyMessage="No Vault projects yet.">{(items) => <div className="q-vault-list">{items.map((project) => <button type="button" key={project.id} data-active={props.selectedProject?.id === project.id} onClick={() => props.onProjectSelect(project.id)}><strong>{project.name}</strong><small>{project.slug}</small></button>)}</div>}</VaultCollectionState>
      <form className="q-vault-form" onSubmit={props.onCreateProject}><h3>New project</h3><label className="q-field"><span className="q-label">Name</span><input className="q-input" required maxLength={MAX_VAULT_PROJECT_NAME_LENGTH} value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} /></label><label className="q-field"><span className="q-label">Slug (optional)</span><input className="q-input" maxLength={80} value={props.projectSlug} onChange={(event) => props.setProjectSlug(event.target.value)} placeholder="pearl-blanc" /></label><label className="q-field"><span className="q-label">Description</span><textarea className="q-input" maxLength={MAX_VAULT_DESCRIPTION_LENGTH} value={props.projectDescription} onChange={(event) => props.setProjectDescription(event.target.value)} /></label><Button type="submit">Create project</Button></form>
    </section>
    <section className="q-card q-card-pad">
      <div className="q-section-heading"><div className="q-section-heading-main"><h2>{props.selectedProject?.name ?? 'Select a project'}</h2></div></div>
      {props.selectedProject && !props.environmentsQuery.data?.length ? <EnvironmentCreateForm {...props} /> : null}
      {props.selectedProject ? <VaultCollectionState query={props.environmentsQuery} resource="Vault environments" emptyMessage="No Vault environments yet. Add one to manage secrets.">{(items) => <>
        <div className="q-vault-environments" role="tablist" aria-label="Vault environments">{items.map((environment) => <button type="button" role="tab" aria-selected={props.selectedEnvironment?.id === environment.id} key={environment.id} data-active={props.selectedEnvironment?.id === environment.id} onClick={() => props.onEnvironmentSelect(environment.id)}>{environment.name}</button>)}<form className="q-vault-inline-form" onSubmit={props.onCreateEnvironment}><input className="q-input" required maxLength={MAX_VAULT_ENVIRONMENT_NAME_LENGTH} value={props.environmentName} onChange={(event) => props.setEnvironmentName(event.target.value)} placeholder="New environment" aria-label="New environment name" /><input className="q-input" maxLength={80} value={props.environmentSlug} onChange={(event) => props.setEnvironmentSlug(event.target.value)} placeholder="slug" aria-label="New environment slug" /><Button type="submit" size="sm">Add</Button></form></div>
        {props.selectedEnvironment ? <>
          <div className="q-section-heading q-vault-secret-heading"><div className="q-section-heading-main"><h2>{props.selectedEnvironment.name} secrets</h2><span className="q-count-badge">{props.secretsQuery.data ? secrets.length : '—'}</span></div></div>
          <VaultCollectionState query={props.secretsQuery} resource="Vault secrets" emptyMessage="No active secrets. Values are never included in this list.">{(items) => <div className="q-vault-secret-list">{items.map((secret) => <div className="q-vault-secret" key={secret.id}><div><strong>{secret.name}</strong><small>v{secret.version} · updated {new Date(secret.updatedAt).toLocaleString()}</small></div><div className="q-vault-actions">{props.revealedSecret && props.revealedSecret.environmentId === props.selectedEnvironment?.id && props.revealedSecret.id === secret.id ? <div className="q-vault-reveal"><code>{props.revealedSecret.value}</code><Button type="button" size="sm" variant="outline" onClick={props.onCopy}>Copy</Button><Button type="button" size="sm" variant="outline" onClick={props.onHide}>Hide</Button></div> : <Button type="button" size="sm" variant="outline" onClick={() => props.onReveal(secret)}>Reveal</Button>}<Button type="button" size="sm" variant="outline" onClick={() => { props.setChangeSecretId(secret.id); props.setSecretName(secret.name); props.setSecretValue(''); props.setSecretDescription(secret.description ?? ''); }}>Rotate</Button><Button type="button" size="sm" variant="danger" onClick={() => void props.onDelete(secret)} disabled={props.busy}>Delete</Button></div></div>)}</div>}</VaultCollectionState>
          <form className="q-vault-form q-vault-secret-form" onSubmit={props.onSaveSecret}><h3>{props.changeSecretId ? 'Rotate secret' : 'New secret'}</h3>{!props.changeSecretId ? <label className="q-field"><span className="q-label">Secret name</span><input className="q-input" required maxLength={MAX_VAULT_SECRET_NAME_LENGTH} value={props.secretName} onChange={(event) => props.setSecretName(event.target.value)} placeholder="CLOUDFLARE_API_TOKEN" /></label> : <p className="q-field-help">Rotating <strong>{props.secretName}</strong> requires the current version and replaces the encrypted value.</p>}<label className="q-field"><span className="q-label">Value</span><textarea className="q-input q-vault-secret-input" required maxLength={MAX_VAULT_SECRET_BYTES} value={props.secretValue} onChange={(event) => props.setSecretValue(event.target.value)} autoComplete="off" /></label><label className="q-field"><span className="q-label">Description</span><textarea className="q-input" maxLength={MAX_VAULT_DESCRIPTION_LENGTH} value={props.secretDescription} onChange={(event) => props.setSecretDescription(event.target.value)} /></label><div className="q-dialog-actions"><Button type="submit" disabled={props.busy}>{props.changeSecretId ? 'Rotate secret' : 'Create secret'}</Button>{props.changeSecretId ? <Button type="button" variant="ghost" onClick={() => { props.setChangeSecretId(null); props.setSecretName(''); props.setSecretValue(''); props.setSecretDescription(''); }}>Cancel</Button> : null}</div><p className="q-field-help">Plaintext is sent only to the Vault endpoint and is not indexed, cached, or saved in Notes.</p></form>
        </> : <VaultEmptyState message="Select an environment to manage its secrets." />}
      </>}</VaultCollectionState> : dependentEnvironmentState}
    </section>
  </div>;
}

type AgentsPanelProps = {
  projectsQuery: VaultProjectsQuery;
  selectedProject: VaultProject | undefined;
  onProjectSelect: (id: string) => void;
  environmentsQuery: VaultEnvironmentsQuery;
  selectedEnvironment: VaultEnvironment | undefined;
  onEnvironmentSelect: (id: string) => void;
  secretsQuery: VaultSecretsQuery;
  tokenSecretId: string | null;
  setTokenSecretId: (value: string | null) => void;
  tokenName: string;
  setTokenName: (value: string) => void;
  tokenScope: GrantScope;
  setTokenScope: (value: GrantScope) => void;
  tokenAction: VaultAgentGrant['action'];
  setTokenAction: (value: VaultAgentGrant['action']) => void;
  tokenExpiry: TokenExpiry;
  setTokenExpiry: (value: TokenExpiry) => void;
  draftGrants: VaultAgentGrant[];
  editingTokenId: string | null;
  editingGrants: VaultAgentGrant[];
  onAddGrant: (target: 'draft' | 'editing') => void;
  onRemoveDraftGrant: (index: number) => void;
  onRemoveEditingGrant: (index: number) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onBeginEdit: (token: VaultToken) => void;
  onCancelEdit: () => void;
  onReplace: () => Promise<void>;
  busy: boolean;
  tokensQuery: VaultTokensQuery;
  issuedToken: string | null;
  closeIssuedToken: () => void;
  copyIssuedToken: () => void;
  onRevoke: (id: string) => Promise<void>;
};

function GrantList(props: { grants: VaultAgentGrant[]; projects: VaultProject[]; environments: VaultEnvironment[]; secrets: VaultSecretMetadata[]; onRemove?: (index: number) => void; label: string }): JSX.Element {
  return <ul className="q-vault-grant-list" aria-label={props.label}>{props.grants.map((grant, index) => <li className="q-vault-grant" key={grant.id ?? `${grant.projectId}-${grant.environmentId ?? 'project'}-${grant.secretId ?? 'all'}-${grant.action}-${index}`}><div><strong>{grantScopeLabel(grant, props.projects, props.environments, props.secrets)}</strong><small>{grantTargetLabel(grant, props.projects, props.environments)} · {grantActionLabel(grant.action)}</small></div>{props.onRemove ? <Button type="button" size="sm" variant="ghost" onClick={() => props.onRemove?.(index)}>Remove</Button> : null}</li>)}</ul>;
}

function AgentsPanel(props: AgentsPanelProps): JSX.Element {
  const projects = props.projectsQuery.data ?? [];
  const environments = props.environmentsQuery.data ?? [];
  const secrets = props.secretsQuery.data ?? [];
  return <div className="q-vault-stack">
    <section className="q-card q-card-pad">
      <div className="q-section-heading"><div className="q-section-heading-main"><h2>Agent credentials</h2></div></div>
      <p className="q-field-help">qvt_ tokens are separate from qnt_ Notes tokens. A raw token is shown once and never stored in browser persistence.</p>
      {props.issuedToken ? <div className="q-vault-issued" role="status"><strong>Copy this token now</strong><code>{props.issuedToken}</code><div className="q-dialog-actions"><Button type="button" onClick={props.copyIssuedToken}>Copy token</Button><Button type="button" variant="ghost" onClick={props.closeIssuedToken}>Close</Button></div></div> : null}
      <form className="q-vault-form" onSubmit={props.onSubmit}>
        <h3>New token</h3>
        <VaultQueryStatus query={props.projectsQuery} resource="Vault projects" emptyMessage="No Vault projects yet. Create a project before issuing a token." />
        <label className="q-field"><span className="q-label">Token name</span><input className="q-input" required maxLength={80} value={props.tokenName} onChange={(event) => props.setTokenName(event.target.value)} placeholder="Hermes deployer" /></label>
        <label className="q-field"><span className="q-label">Project</span><select className="q-input" required value={props.selectedProject?.id ?? ''} onChange={(event) => props.onProjectSelect(event.target.value)} disabled={!projects.length}><option value="">Select a project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <label className="q-field"><span className="q-label">Grant scope</span><select className="q-input" value={props.tokenScope} onChange={(event) => props.setTokenScope(event.target.value as GrantScope)}><option value="project">Selected project</option><option value="environment">Selected environment</option><option value="secret">Selected secret</option></select></label>
        {props.tokenScope !== 'project' ? <>{props.selectedProject ? <VaultQueryStatus query={props.environmentsQuery} resource="Vault environments" emptyMessage="No Vault environments yet. Create one before adding a scoped grant." /> : null}<label className="q-field"><span className="q-label">Environment</span><select className="q-input" required value={props.selectedEnvironment?.id ?? ''} onChange={(event) => props.onEnvironmentSelect(event.target.value)} disabled={!environments.length}><option value="">Select an environment</option>{environments.map((environment) => <option value={environment.id} key={environment.id}>{environment.name}</option>)}</select></label></> : null}
        {props.tokenScope === 'secret' ? <>{props.selectedEnvironment ? <VaultQueryStatus query={props.secretsQuery} resource="Vault secrets" emptyMessage="No active secrets yet. Create one before adding a secret-scoped grant." /> : null}<label className="q-field"><span className="q-label">Secret</span><select className="q-input" required value={props.tokenSecretId ?? ''} onChange={(event) => props.setTokenSecretId(event.target.value || null)} disabled={!secrets.length}><option value="">Select a secret</option>{secrets.map((secret) => <option value={secret.id} key={secret.id}>{secret.name}</option>)}</select></label></> : null}
        <label className="q-field"><span className="q-label">Action</span><select className="q-input" value={props.tokenAction} onChange={(event) => props.setTokenAction(event.target.value as VaultAgentGrant['action'])}><option value="metadata:read">Metadata read</option><option value="secret:reveal">Secret reveal</option><option value="secret:write">Secret write</option><option value="secret:delete">Secret delete</option></select></label>
        <Button type="button" variant="outline" onClick={() => props.onAddGrant('draft')} disabled={props.busy || !projects.length}>Add grant</Button>
        <section className="q-vault-grants" aria-labelledby="new-token-grants-heading"><div className="q-section-heading"><div className="q-section-heading-main"><h3 id="new-token-grants-heading">New token grants</h3><span className="q-count-badge">{props.draftGrants.length}</span></div></div>{props.draftGrants.length ? <GrantList grants={props.draftGrants} projects={projects} environments={environments} secrets={secrets} onRemove={props.onRemoveDraftGrant} label="New token grants" /> : <p className="q-empty">No grants added yet. Add at least one project, environment, or secret grant before creating the token.</p>}</section>
        <label className="q-field"><span className="q-label">Token expiry</span><select className="q-input" value={props.tokenExpiry} onChange={(event) => props.setTokenExpiry(event.target.value as TokenExpiry)}>{tokenExpiryOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <Button type="submit" disabled={props.busy || !projects.length || !props.draftGrants.length}>Create qvt token</Button>
      </form>
    </section>
    <section className="q-card q-card-pad">
      <div className="q-section-heading"><div className="q-section-heading-main"><h2>Issued tokens</h2><span className="q-count-badge">{props.tokensQuery.data ? props.tokensQuery.data.length : '—'}</span></div></div>
      <VaultCollectionState query={props.tokensQuery} resource="Vault agent tokens" emptyMessage="No qvt agent tokens yet.">{(tokens) => <div className="q-vault-token-list">{tokens.map((token) => {
        const grants = token.grants ?? [];
        const editing = props.editingTokenId === token.id;
        return <article className="q-vault-token" key={token.id}>
          <div className="q-vault-token-main"><strong>{token.name}</strong><small><code>{token.tokenPrefix}</code> · {token.revokedAt ? 'revoked' : 'active'} · last used {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : 'never'}</small>
            {!editing ? <div className="q-vault-token-grants"><strong>Effective grants ({grants.length})</strong>{grants.length ? <GrantList grants={grants} projects={projects} environments={environments} secrets={secrets} label={`${token.name} effective grants`} /> : <small>No grants. This token cannot access Vault resources.</small>}</div> : <div className="q-vault-token-grants"><strong>Edit grant set ({props.editingGrants.length})</strong>{props.editingGrants.length ? <GrantList grants={props.editingGrants} projects={projects} environments={environments} secrets={secrets} onRemove={props.onRemoveEditingGrant} label={`${token.name} editable grants`} /> : <small>No grants. Saving removes every grant and leaves the token unable to access Vault resources.</small>}<div className="q-vault-actions"><Button type="button" size="sm" variant="outline" onClick={() => props.onAddGrant('editing')} disabled={props.busy}>Add selected grant</Button><Button type="button" size="sm" onClick={() => void props.onReplace()} disabled={props.busy}>Replace grant set</Button><Button type="button" size="sm" variant="ghost" onClick={props.onCancelEdit} disabled={props.busy}>Cancel</Button></div></div>}
          </div>
          {!editing ? <div className="q-vault-actions"><Button type="button" size="sm" variant="outline" onClick={() => props.onBeginEdit(token)}>Edit grants</Button>{!token.revokedAt ? <Button type="button" size="sm" variant="danger" onClick={() => void props.onRevoke(token.id)} disabled={props.busy}>Revoke</Button> : null}</div> : null}
        </article>;
      })}</div>}</VaultCollectionState>
    </section>
  </div>;
}

function AuditPanel({ query }: { query: VaultAuditQuery }): JSX.Element {
  return <section className="q-card q-card-pad"><div className="q-section-heading"><div className="q-section-heading-main"><h2>Vault audit history</h2><span className="q-count-badge">{query.data ? query.data.length : '—'}</span></div></div><VaultCollectionState query={query} resource="Vault audit history" emptyMessage="No Vault events yet. Secret values are never recorded in audit history.">{(events) => <div className="q-vault-audit-list">{events.map((event) => {
    const actor = event.actorKind === 'vault_agent'
      ? `${event.actorTokenName ?? 'Agent token'}${event.actorTokenPrefix ? ` (${event.actorTokenPrefix})` : ''}`
      : 'User JWT';
    return <div className="q-vault-audit" key={event.id}><strong>{event.action}</strong><span>{new Date(event.occurredAt).toLocaleString()} · {actor} · {event.success ? 'success' : 'failed'}</span><small>{event.projectId ?? 'No project'}{event.secretId ? ` · secret ${event.secretId}` : ''}{event.resultCode ? ` · ${event.resultCode}` : ''}{event.purpose ? ` · purpose: ${event.purpose}` : ''}</small></div>;
  })}</div>}</VaultCollectionState></section>;
}
