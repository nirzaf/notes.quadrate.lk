import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QNotesClient } from '@qnotes/api-client';
import type { ApiTokenMetadata, ApiTokenScope, HermesVaultMcpProfile } from '@qnotes/shared';
import { buildHermesMcpConfig } from '@qnotes/shared';
import { api } from '../api';
import { env } from '../env';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useToast } from './ui/toast';
import { useAuth } from '../auth-context';

type IntegrationProfile = 'read' | 'share' | 'write';
type ExpiryChoice = '7d' | '30d' | '90d' | '1y' | 'never';
type VerificationState = 'idle' | 'verifying' | 'verified' | 'failed';

const requiredScopes: Record<IntegrationProfile, ApiTokenScope[]> = {
  read: ['notes:read', 'search:read'],
  share: ['notes:read', 'search:read', 'shares:write'],
  write: ['notes:read', 'search:read', 'notes:write'],
};
const optionalScopes: ApiTokenScope[] = ['shares:write', 'attachments:read', 'attachments:write'];
const scopeDescriptions: Record<ApiTokenScope, string> = {
  'notes:read': 'list and read notes, notebooks, and reusable blocks',
  'search:read': 'search note sections, blocks, and indexed attachment text',
  'notes:write': 'create, append, update, move, and restore notes',
  'shares:write': 'create, view, and revoke public note links for your own notes',
  'attachments:read': 'list attachments and open private files',
  'attachments:write': 'upload, finalize, and delete attachments',
};
const expiryChoices: Array<{ value: ExpiryChoice; label: string; days?: number }> = [
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
  { value: '1y', label: '1 year', days: 365 },
  { value: 'never', label: 'Does not expire' },
];
const mcpServerPath = '/absolute/local/path/to/notes.quadrate.lk/packages/mcp-server/dist/index.js';
const vaultProfileChoices: Array<{ value: HermesVaultMcpProfile; label: string; description: string }> = [
  { value: 'none', label: 'No Vault', description: 'Generate Notes tools only.' },
  { value: 'metadata', label: 'Vault metadata', description: 'List the Vault metadata allowed by QVAULT_TOKEN without revealing values.' },
  { value: 'reveal', label: 'Vault reveal', description: 'Add explicit single and bounded batch secret reveal tools.' },
  { value: 'write', label: 'Vault write', description: 'Add Vault secret create, rotate, and delete tools.' },
];

interface IssuedToken {
  token: string;
  metadata: ApiTokenMetadata;
  profile: IntegrationProfile;
  vaultProfile: HermesVaultMcpProfile;
  deviceId?: string;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const element = document.createElement('textarea');
  element.value = value;
  element.style.position = 'fixed';
  element.style.opacity = '0';
  document.body.append(element);
  element.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard access was unavailable.');
  } finally {
    element.remove();
  }
}

function selectedExpiry(choice: ExpiryChoice): string | null {
  const selected = expiryChoices.find((item) => item.value === choice);
  return selected?.days ? new Date(Date.now() + selected.days * 24 * 60 * 60 * 1000).toISOString() : null;
}

function expiryLabel(value: string | null): string {
  return value ? `Expires ${new Date(value).toLocaleDateString()}` : 'Does not expire';
}

export function TokenManager(): JSX.Element {
  const [tokens, setTokens] = useState<ApiTokenMetadata[]>([]);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<IntegrationProfile>('read');
  const [vaultProfile, setVaultProfile] = useState<HermesVaultMcpProfile>('none');
  const [extraScopes, setExtraScopes] = useState<ApiTokenScope[]>([]);
  const [expiry, setExpiry] = useState<ExpiryChoice>('30d');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [creating, setCreating] = useState(false);
  const [verification, setVerification] = useState<VerificationState>('idle');
  const { toast } = useToast();
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const mountedRef = useRef(true);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  useEffect(() => () => { mountedRef.current = false; }, []);
  const refresh = useCallback(() => {
    if (!userId) return;
    const requestUserId = userId;
    const controller = new AbortController();
    void api.listTokens({ signal: controller.signal }).then((next) => {
      if (mountedRef.current && userIdRef.current === requestUserId) setTokens(next);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (mountedRef.current && userIdRef.current === requestUserId) toast('Unable to load tokens.', 'error');
    });
  }, [toast, userId]);
  useEffect(() => {
    setTokens([]); setIssued(null); setVerification('idle'); setCreating(false);
    if (!userId) return undefined;
    const requestUserId = userId;
    const controller = new AbortController();
    void api.listTokens({ signal: controller.signal }).then((next) => {
      if (mountedRef.current && userIdRef.current === requestUserId) setTokens(next);
    }).catch((error: unknown) => { if (error instanceof DOMException && error.name === 'AbortError') return; if (mountedRef.current && userIdRef.current === requestUserId) toast('Unable to load tokens.', 'error'); });
    return () => controller.abort();
  }, [toast, userId]);

  const scopes = useMemo(() => [...requiredScopes[profile], ...extraScopes.filter((scope) => !requiredScopes[profile].includes(scope))], [extraScopes, profile]);
  const config = useMemo(() => issued ? buildHermesMcpConfig({
    profile: issued.profile,
    serverPath: mcpServerPath,
    vaultProfile: issued.vaultProfile,
    ...(issued.deviceId ? { deviceId: issued.deviceId } : {}),
    ...(issued.profile === 'share' || issued.metadata.scopes.includes('shares:write') ? { includePublicShare: true } : {}),
  }) : null, [issued]);

  const chooseProfile = (nextProfile: IntegrationProfile) => {
    setProfile(nextProfile);
    setExtraScopes((current) => current.filter((scope) => optionalScopes.includes(scope)));
  };
  const toggleExtraScope = (scope: ApiTokenScope, enabled: boolean) => {
    setExtraScopes((current) => enabled ? [...current, scope].filter((item, index, all) => all.indexOf(item) === index) : current.filter((item) => item !== scope));
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || creating || !userIdRef.current) return;
    const requestUserId = userIdRef.current;
    setCreating(true);
    setVerification('idle');
    try {
      const result = await api.createToken({ name: name.trim(), scopes, expiresAt: selectedExpiry(expiry) });
      if (!mountedRef.current || userIdRef.current !== requestUserId) return;
      const deviceId = profile === 'write' ? crypto.randomUUID() : undefined;
      setIssued({ token: result.token, metadata: result.metadata, profile, vaultProfile, ...(deviceId ? { deviceId } : {}) });
      setTokens((current) => [result.metadata, ...current]);
      setName('');
      toast('Token created. Copy it now; the full value will not be shown again.', 'success');
    } catch (error: unknown) {
      if (mountedRef.current && userIdRef.current === requestUserId) toast(error instanceof Error ? error.message : 'Unable to create token.', 'error');
    } finally {
      if (mountedRef.current && userIdRef.current === requestUserId) setCreating(false);
    }
  };
  const revoke = async (id: string) => {
    if (!userIdRef.current) return;
    const requestUserId = userIdRef.current;
    try { await api.revokeToken(id); if (mountedRef.current && userIdRef.current === requestUserId) { refresh(); toast('Token revoked.', 'success'); } } catch { if (mountedRef.current && userIdRef.current === requestUserId) toast('Unable to revoke token.', 'error'); }
  };
  const verifyApi = async () => {
    if (!issued || verification === 'verifying') return;
    const requestUserId = userIdRef.current;
    setVerification('verifying');
    try {
      const tokenClient = new QNotesClient({ baseUrl: env.qnotesApiUrl, getAccessToken: () => issued.token });
      await tokenClient.listNotes({ limit: 1 });
      if (mountedRef.current && userIdRef.current === requestUserId) setVerification('verified');
    } catch {
      if (mountedRef.current && userIdRef.current === requestUserId) setVerification('failed');
    }
  };
  const copy = async (value: string, message: string) => {
    try { await copyText(value); toast(message, 'success'); } catch { toast('Clipboard access was unavailable. Select and copy the value manually.', 'error'); }
  };

  return <div className="q-panel-stack">
    <section className="q-card q-card-pad q-panel q-integration-setup">
      <p className="q-eyebrow">Hermes integration</p>
      <h3>Connect Hermes to Quadrate Notes</h3>
      <p>Start with a read-only connection. Use the share profile when Hermes should create guarded 24-hour public links, or the writing profile when it should change notes. Token scopes are enforced by the API, and attachment writing is never included by default.</p>
      <form className="q-panel-stack" onSubmit={create}>
        <label className="q-field"><span className="q-label">Token name</span><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Hermes read-only" maxLength={80} /></label>
        <fieldset className="q-integration-fieldset">
          <legend className="q-label">Access profile</legend>
          <div className="q-integration-profiles">
            <label className="q-integration-profile"><input type="radio" name="hermes-profile" checked={profile === 'read'} onChange={() => chooseProfile('read')} /><span><strong>Read-only</strong><small>Search and read notes without write tools.</small></span></label>
            <label className="q-integration-profile"><input type="radio" name="hermes-profile" checked={profile === 'share'} onChange={() => chooseProfile('share')} /><span><strong>Public sharing</strong><small>Create guarded 24-hour links without note mutation tools.</small></span></label>
            <label className="q-integration-profile"><input type="radio" name="hermes-profile" checked={profile === 'write'} onChange={() => chooseProfile('write')} /><span><strong>Writing</strong><small>Also allow capture, append, and update note tools.</small></span></label>
          </div>
        </fieldset>
        <fieldset className="q-integration-fieldset">
          <legend className="q-label">Vault profile</legend>
          <p className="q-field-help">Vault access is additive to the Notes profile. This page does not create or display a Vault secret; supply your separate <code>QVAULT_TOKEN</code> in Hermes’ environment-backed secret file.</p>
          <div className="q-integration-profiles">
            {vaultProfileChoices.map((choice) => <label className="q-integration-profile" key={choice.value}><input type="radio" name="hermes-vault-profile" checked={vaultProfile === choice.value} onChange={() => setVaultProfile(choice.value)} /><span><strong>{choice.label}</strong><small>{choice.description}</small></span></label>)}
          </div>
        </fieldset>
        <fieldset className="q-integration-fieldset">
          <legend className="q-label">Granted scopes</legend>
          <div className="q-integration-scopes">
            {[...requiredScopes[profile], ...optionalScopes].filter((scope, index, all) => all.indexOf(scope) === index).map((scope) => {
              const required = requiredScopes[profile].includes(scope);
              return <label className="q-integration-scope" key={scope}><input type="checkbox" checked={scopes.includes(scope)} disabled={required} onChange={(event) => toggleExtraScope(scope, event.target.checked)} /><span><strong>{scope}</strong><small>{required ? 'Required for this profile: ' : ''}{scopeDescriptions[scope]}.</small></span></label>;
            })}
          </div>
        </fieldset>
        <label className="q-field"><span className="q-label">Token expiry</span><select className="q-input" value={expiry} onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}>{expiryChoices.map((choice) => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</select><span className="q-field-help">Choose “Does not expire” only when a long-lived token is intentional.</span></label>
        <Button type="submit" disabled={creating || !name.trim()}>{creating ? 'Creating token…' : `Create ${profile === 'write' ? 'writing' : profile === 'share' ? 'sharing' : 'read-only'} token`}</Button>
      </form>
      {issued && <div className="q-token-issued" aria-live="polite">
        <div className="q-token-issued-heading"><strong>Token created successfully</strong><span className="q-small">{issued.metadata.name} · {expiryLabel(issued.metadata.expiresAt)}</span></div>
        <p>Copy the secret now. It is held only in this page’s transient memory and will disappear when you hide it or leave this page.</p>
        <div className="q-token-secret"><code data-testid="issued-token">{issued.token}</code><Button type="button" variant="secondary" size="sm" onClick={() => void copy(issued.token, 'Token copied. Store it in your password manager.')}>Copy token</Button></div>
        {config && <>
          <div className="q-token-issued-heading"><strong>Hermes configuration</strong><span className="q-small">Valid YAML/JSON; replace the path and environment placeholders.</span></div>
          <pre className="q-config-block"><code>{config}</code></pre>
          {issued.vaultProfile !== 'none' && <p className="q-field-help">This combined configuration contains only the <code>QVAULT_TOKEN</code> placeholder and the selected <code>QVAULT_MCP_PROFILE</code>. Create a qvt Vault agent token separately in Agent Vault and supply it through Hermes’ secret environment; its raw value is never displayed here.</p>}
          <div className="q-dialog-actions"><Button type="button" variant="outline" onClick={() => void copy(config, 'Hermes configuration copied.')}>Copy configuration</Button><Button type="button" variant="ghost" onClick={() => void verifyApi()} disabled={verification === 'verifying'}>{verification === 'verifying' ? 'Verifying API access…' : 'Verify token/API access'}</Button><Button type="button" variant="ghost" onClick={() => { setIssued(null); setVerification('idle'); }}>Hide one-time secret</Button></div>
          <p className={verification === 'failed' ? 'q-error' : 'q-integration-verification'} role={verification === 'failed' ? 'alert' : 'status'}>{verification === 'verified' ? 'Token/API access verified. This browser check does not verify Hermes.' : verification === 'failed' ? 'Token/API access could not be verified. Check the token, expiry, and selected scopes.' : 'Hermes is not connected yet. After saving the configuration, run hermes mcp test in your terminal to verify the real stdio round trip.'}</p>
          {issued.profile === 'write' && issued.deviceId && <p className="q-field-help">Keep QNOTES_MCP_DEVICE_ID <code>{issued.deviceId}</code> unchanged when retrying an ambiguous write or restarting Hermes.</p>}
        </>}
      </div>}
    </section>
    <section className="q-card q-card-pad q-panel"><h3>Existing tokens</h3><div className="q-token-list">{tokens.length ? tokens.map((token) => <div className="q-token-row" key={token.id}><div><div className="q-token-name">{token.name}</div><div className="q-small">{token.tokenPrefix} · {token.scopes.join(', ')} · {expiryLabel(token.expiresAt)}{token.revokedAt ? ' · revoked' : ''}</div></div>{!token.revokedAt && <Button variant="ghost" size="sm" onClick={() => void revoke(token.id)}>Revoke</Button>}</div>) : <p>No personal tokens yet.</p>}</div></section>
    <section className="q-card q-card-pad q-panel"><h3>Finish setup in Hermes</h3><p>Build this repository’s MCP server, put the selected Notes token in Hermes’ environment-backed secret file, paste the generated entry into <code>~/.hermes/config.yaml</code>, then run <code>hermes mcp test quadrate_notes_&lt;profile&gt;</code>. The test result is the Hermes verification; an API check in this browser is only token/API verification.</p><p>If you selected a Vault profile, create a separate qvt Vault agent token in Agent Vault and provide it as <code>QVAULT_TOKEN</code> in the same Hermes secret environment. The generated configuration supplies only the placeholder and profile name; it never contains the raw Vault token. A share token must retain <code>shares:write</code> and is used as the caller-owned credential for share management. For a writing token, retain the generated <code>QNOTES_MCP_DEVICE_ID</code> value across process restarts. Pass the same <code>mutationId</code> when retrying an ambiguous capture, append, or update. Omitting it remains supported, but each call is treated as a new operation.</p></section>
  </div>;
}
