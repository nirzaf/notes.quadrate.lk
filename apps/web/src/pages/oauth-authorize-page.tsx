import { useMemo } from 'react';
import { env } from '../env';

const REQUIRED_PARAMS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method'] as const;

function authorizationEndpoint(): string {
  return `${env.supabaseUrl.replace(/\/$/, '')}/functions/v1/qnotes-mcp/authorize`;
}

export function OAuthAuthorizePage(): JSX.Element {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const missing = REQUIRED_PARAMS.filter((name) => !params.get(name));
  const invalidPkce = params.get('code_challenge_method') !== 'S256';

  if (missing.length > 0 || invalidPkce) {
    return <main className="q-auth-page"><section className="q-card q-auth-card" role="alert"><p className="q-eyebrow">Quadrate Notes</p><h1 className="q-display" style={{ fontSize: '2.8rem' }}>This connection request is incomplete.</h1><p className="q-subtitle">Return to Gemini Spark and start the connection again. No token was requested or stored.</p></section></main>;
  }

  const clientName = params.get('client_name') || 'A registered application';
  const scope = params.get('scope') || 'ACCESS_VIEW_MANAGE_MCP_CONTENT';
  const resource = params.get('resource') || `${env.supabaseUrl.replace(/\/$/, '')}/functions/v1/qnotes-mcp`;

  return <main className="q-auth-page"><section className="q-card q-auth-card" aria-labelledby="oauth-title"><p className="q-eyebrow">Quadrate Notes</p><h1 id="oauth-title" className="q-display" style={{ fontSize: '2.8rem' }}>Connect to your notes.</h1><p className="q-subtitle"><strong>{clientName}</strong> is requesting read-only access to your Quadrate Notes MCP tools.</p><p className="q-field-help">Enter the personal token you created in Quadrate Notes. It is sent only to the authorization endpoint and is exchanged for a short-lived authorization code; it is never included in this page URL.</p><form className="q-auth-form" method="post" action={authorizationEndpoint()}><input type="hidden" name="client_id" value={params.get('client_id') ?? ''} /><input type="hidden" name="redirect_uri" value={params.get('redirect_uri') ?? ''} /><input type="hidden" name="state" value={params.get('state') ?? ''} /><input type="hidden" name="code_challenge" value={params.get('code_challenge') ?? ''} /><input type="hidden" name="code_challenge_method" value="S256" /><input type="hidden" name="scope" value={scope} /><input type="hidden" name="resource" value={resource} /><label className="q-field"><span className="q-label">Quadrate Notes personal token</span><input className="q-input" name="qnotes_token" type="password" autoComplete="off" placeholder="qnt_…" required autoFocus /></label><div className="q-dialog-actions"><button className="q-button q-button-primary" name="decision" value="approve" type="submit">Approve &amp; Connect</button><button className="q-button q-button-outline" name="decision" value="deny" type="submit" formNoValidate>Cancel</button></div></form></section></main>;
}
