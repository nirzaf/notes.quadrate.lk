import { useEffect, useState } from 'react';
import type { ApiTokenMetadata, ApiTokenScope, CreateApiTokenResult } from '@qnotes/shared';
import { api } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useToast } from './ui/toast';

const scopes: ApiTokenScope[] = ['notes:read', 'notes:write', 'search:read', 'attachments:read', 'attachments:write'];

export function TokenManager(): JSX.Element {
  const [tokens, setTokens] = useState<ApiTokenMetadata[]>([]);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<ApiTokenScope[]>(['notes:read', 'search:read']);
  const [newToken, setNewToken] = useState<CreateApiTokenResult | null>(null);
  const { toast } = useToast();
  const refresh = () => { void api.listTokens().then(setTokens).catch(() => toast('Unable to load tokens.', 'error')); };
  useEffect(refresh, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try { setNewToken(await api.createToken({ name: name.trim(), scopes: selected, expiresAt: null })); setName(''); refresh(); } catch (error: unknown) { toast(error instanceof Error ? error.message : 'Unable to create token.', 'error'); }
  };
  const revoke = async (id: string) => { try { await api.revokeToken(id); refresh(); toast('Token revoked.', 'success'); } catch { toast('Unable to revoke token.', 'error'); } };
  return <div className="q-panel-stack"><section className="q-card q-card-pad q-panel"><h3>Create personal token</h3><p>Personal tokens are shown in full once. Store them in your password manager.</p><form className="q-panel-stack" onSubmit={create}><label className="q-field"><span className="q-label">Token name</span><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Codex read only" /></label><fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="q-label">Scopes</legend><div className="q-tag-row">{scopes.map((scope) => <label className="q-badge" key={scope} style={{ cursor: 'pointer' }}><input type="checkbox" checked={selected.includes(scope)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} />{scope}</label>)}</div></fieldset><Button type="submit">Create token</Button></form>{newToken && <div className="q-error" style={{ marginTop: 16 }}>Copy this token now; it will not be shown again.<br /><code>{newToken.token}</code></div>}</section><section className="q-card q-card-pad q-panel"><h3>Existing tokens</h3><div className="q-token-list">{tokens.length ? tokens.map((token) => <div className="q-token-row" key={token.id}><div><div className="q-token-name">{token.name}</div><div className="q-small">{token.tokenPrefix} · {token.scopes.join(', ')}{token.revokedAt ? ' · revoked' : ''}</div></div>{!token.revokedAt && <Button variant="ghost" size="sm" onClick={() => void revoke(token.id)}>Revoke</Button>}</div>) : <p>No personal tokens yet.</p>}</div></section></div>;
}
