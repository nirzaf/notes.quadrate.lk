import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createClient } from '@supabase/supabase-js';
import { QNotesClient } from '@qnotes/api-client';
import { createQNotesMcpServer } from '../_shared/generated/mcp-server/server.ts';
import { isUUID } from '@qnotes/shared';
import { hashPersonalToken, isPersonalToken } from '../_shared/token.ts';
import { boundedRequest, RequestBodyTooLarge } from '../_shared/request-body.ts';
import { consumeRequestBudget, MAX_MCP_REQUEST_BODY_BYTES, MAX_OAUTH_FORM_BODY_BYTES, MAX_OAUTH_REGISTER_BODY_BYTES, requestClientPrincipal } from '../_shared/request-limits.ts';
import { base64Url, decodeBase64Url, isOAuthAccessToken, signOAuthValue, verifyOAuthAccessToken, verifyOAuthValue } from '../_shared/oauth-grant.ts';
import { configuredStaticRedirectUris, hostedMcpOAuthScopes, HOSTED_MCP_OAUTH_SCOPE, isAllowedGoogleRedirect } from './oauth-redirects.ts';

const MCP_PATHS = new Set(['', '/', '/mcp']);
const STATIC_OAUTH_CLIENT_ID = Deno.env.get('QNOTES_MCP_OAUTH_CLIENT_ID') ?? 'qnotes-gemini';
const OAUTH_CODE_TTL_SECONDS = 90;
const OAUTH_ACCESS_TTL_SECONDS = 15 * 60;
const OAUTH_CLIENT_TTL_SECONDS = 90 * 24 * 60 * 60;
const OAUTH_CONSENT_URL = Deno.env.get('QNOTES_MCP_CONSENT_URL')?.trim() || 'https://notes.quadrate.lk/oauth/authorize';
// Hosted deployments intentionally support only read and the explicit share
// profile. Every other value, including write, remains read-only. OAuth bearer
// requests carry a persisted grant reference; the personal token stays server-side.
const HOSTED_MCP_PROFILE = Deno.env.get('QNOTES_MCP_PROFILE') === 'share' ? 'share' : 'read';

interface OAuthCodePayload {
  type: 'authorization_code';
  codeId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  grantId: string;
  expiresAt: number;
}

interface OAuthClientPayload {
  type: 'client';
  redirectUriHashes: string[];
  clientName: string;
  expiresAt: number;
  nonce: string;
}

interface OAuthGrantContext {
  owner_id: string;
  scopes: string[];
  access_mode: 'account' | 'notebooks';
  allow_unfiled: boolean;
  policy_revision: number;
  notebook_ids: string[];
  expires_at: string;
}

let oauthServiceClient: ReturnType<typeof createClient> | null = null;

function getOAuthServiceClient(): ReturnType<typeof createClient> {
  if (oauthServiceClient) return oauthServiceClient;
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) throw new Error('OAuth replay protection is not configured.');
  oauthServiceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  return oauthServiceClient;
}

async function consumeAuthorizationCode(codeId: string, expiresAt: number): Promise<boolean> {
  const result = await getOAuthServiceClient().rpc('qnotes_consume_oauth_authorization_code', {
    p_code_id: codeId,
    p_expires_at: new Date(expiresAt * 1000).toISOString(),
  } as never) as unknown as { data: unknown; error: { message: string } | null };
  if (result.error || typeof result.data !== 'boolean') throw new Error('Unable to consume the OAuth authorization code.');
  return result.data;
}

async function oauthGrantContext(grantId: string, clientId: string, resource: string): Promise<OAuthGrantContext[] | null> {
  try {
    const result = await getOAuthServiceClient().rpc('qnotes_oauth_grant_context', {
      p_grant_id: grantId,
      p_client_id: clientId,
      p_resource: resource,
    } as never) as unknown as { data: unknown; error: { message: string } | null };
    if (result.error || !Array.isArray(result.data)) return null;
    return result.data as OAuthGrantContext[];
  } catch {
    return null;
  }
}

async function createOAuthGrant(token: string, clientId: string, resource: string, scope: string): Promise<string | 'denied' | 'unavailable'> {
  const scopes = hostedMcpOAuthScopes(scope, HOSTED_MCP_PROFILE);
  if (!scopes) return 'denied';
  try {
    const result = await getOAuthServiceClient().rpc('qnotes_create_oauth_grant', {
      p_token_hash: await hashPersonalToken(token),
      p_client_id: clientId,
      p_resource: resource,
      p_scopes: scopes,
      p_expires_at: new Date((Math.floor(Date.now() / 1000) + OAUTH_ACCESS_TTL_SECONDS) * 1000).toISOString(),
      p_access_mode: null,
      p_allow_unfiled: null,
      p_notebook_ids: null,
    } as never) as unknown as { data: unknown; error: { message: string } | null };
    if (result.error) {
      return /oauth_invalid_token|oauth_scope_not_granted|oauth_access_not_granted/.test(result.error.message) ? 'denied' : 'unavailable';
    }
    const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data as Record<string, unknown> : null;
    const grantId = data?.id;
    if (typeof grantId !== 'string' || !isUUID(grantId)) return 'unavailable';
    return grantId;
  } catch {
    return 'unavailable';
  }
}

async function revokeOAuthGrant(grantId: string, clientId: string, resource: string): Promise<boolean | null> {
  try {
    const result = await getOAuthServiceClient().rpc('qnotes_revoke_oauth_grant', {
      p_grant_id: grantId,
      p_client_id: clientId,
      p_resource: resource,
    } as never) as unknown as { data: unknown; error: { message: string } | null };
    if (result.error || typeof result.data !== 'boolean') return null;
    return result.data;
  } catch {
    return null;
  }
}

function requestPath(request: Request): string {
  const path = new URL(request.url).pathname.replace(/^\/qnotes-mcp(?=\/|$)/, '');
  return path === '/' ? '/' : path;
}

function mcpBaseUrl(request: Request): string {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
  if (supabaseUrl) return `${supabaseUrl}/functions/v1/qnotes-mcp`;
  const url = new URL(request.url);
  const marker = '/qnotes-mcp';
  const markerIndex = url.pathname.indexOf(marker);
  const path = markerIndex >= 0
    ? url.pathname.slice(0, markerIndex + marker.length)
    : '/functions/v1/qnotes-mcp';
  return `${url.origin}${path}`;
}

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const allowed = (Deno.env.get('QNOTES_MCP_ALLOWED_ORIGINS') ?? 'https://gemini.google.com')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function withCors(request: Request, response: Response): Response {
  const origin = allowedOrigin(request);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(request: Request, body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  return withCors(request, new Response(JSON.stringify(body), { status, headers }));
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function redirectFingerprint(uri: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uri));
  return base64Url(new Uint8Array(digest).slice(0, 12));
}

function oauthError(request: Request, error: string, description: string, status = 400, extraHeaders?: Record<string, string>): Response {
  return json(request, { error, error_description: description }, status, {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    ...extraHeaders,
  });
}

async function oauthBudget(request: Request): Promise<Response | null> {
  try {
    const decision = await consumeRequestBudget('oauth', requestClientPrincipal(request));
    if (decision.unavailable) return oauthError(request, 'temporarily_unavailable', 'Request capacity could not be verified. Retry later.', 503);
    if (!decision.allowed) return oauthError(request, 'slow_down', 'Too many OAuth requests. Retry later.', 429, { 'Retry-After': String(Math.max(1, decision.retryAfterSeconds)) });
    return null;
  } catch {
    return oauthError(request, 'temporarily_unavailable', 'Request capacity could not be verified. Retry later.', 503);
  }
}

function oauthMetadata(request: Request): Record<string, unknown> {
  const base = mcpBaseUrl(request);
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [HOSTED_MCP_OAUTH_SCOPE],
    revocation_endpoint: `${base}/revoke`,
  };
}

function oauthResourceMetadata(request: Request): Record<string, unknown> {
  const base = mcpBaseUrl(request);
  return {
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [HOSTED_MCP_OAUTH_SCOPE],
  };
}

function basicClientId(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = new TextDecoder().decode(decodeBase64Url(header.slice(6).trim()));
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return decoded.slice(0, separator);
  } catch {
    return null;
  }
}

async function oauthClient(clientId: string): Promise<OAuthClientPayload | null> {
  if (!clientId || clientId.length > 4096) return null;
  if (clientId === STATIC_OAUTH_CLIENT_ID) {
    const configured = configuredStaticRedirectUris(Deno.env.get('QNOTES_MCP_STATIC_REDIRECT_URIS'));
    if (!configured) return null;
    const redirectUriHashes = await Promise.all(configured.map(redirectFingerprint));
    return { type: 'client', redirectUriHashes, clientName: 'Google', expiresAt: Number.MAX_SAFE_INTEGER, nonce: 'static' };
  }
  const client = await verifyOAuthValue<OAuthClientPayload>(clientId, 'qdc');
  if (!client || client.type !== 'client' || client.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  if (!Array.isArray(client.redirectUriHashes) || client.redirectUriHashes.length === 0 || client.redirectUriHashes.length > 16 || !client.redirectUriHashes.every((hash) => typeof hash === 'string' && /^[A-Za-z0-9_-]{16}$/.test(hash))) return null;
  return client;
}

async function clientAllowsRedirect(client: OAuthClientPayload, redirectUri: string): Promise<boolean> {
  if (!isAllowedGoogleRedirect(redirectUri)) return false;
  return client.redirectUriHashes.includes(await redirectFingerprint(redirectUri));
}

function consentRedirect(request: Request, data: { clientId: string; clientName: string; redirectUri: string; state: string; codeChallenge: string; scope: string; resource: string }): Response {
  const consentUrl = new URL(OAUTH_CONSENT_URL);
  const values = {
    client_id: data.clientId,
    client_name: data.clientName,
    redirect_uri: data.redirectUri,
    state: data.state,
    code_challenge: data.codeChallenge,
    code_challenge_method: 'S256',
    scope: data.scope,
    resource: data.resource,
  };
  for (const [key, value] of Object.entries(values)) consentUrl.searchParams.set(key, value);
  return withCors(request, new Response(null, {
    status: 302,
    headers: {
      Location: consentUrl.toString(),
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  }));
}

function authorizationRedirect(request: Request, redirectUri: string, values: Record<string, string>): Response {
  const redirect = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
  return withCors(request, new Response(null, {
    status: 302,
    headers: { Location: redirect.toString(), 'Cache-Control': 'no-store' },
  }));
}

async function handleRegister(request: Request): Promise<Response> {
  const limited = await oauthBudget(request);
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return oauthError(request, 'invalid_client_metadata', 'The registration request must be JSON.');
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((value): value is string => typeof value === 'string') : [];
  if (redirectUris.length === 0 || redirectUris.length > 16 || redirectUris.some((uri) => !isAllowedGoogleRedirect(uri))) return oauthError(request, 'invalid_redirect_uri', 'Only HTTPS Google OAuth redirect URIs are allowed.');
  const clientName = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 128) : 'Google';
  const now = Math.floor(Date.now() / 1000);
  const redirectUriHashes = await Promise.all(redirectUris.map(redirectFingerprint));
  const clientId = await signOAuthValue('qdc', {
    type: 'client',
    redirectUriHashes,
    clientName,
    expiresAt: now + OAUTH_CLIENT_TTL_SECONDS,
    nonce: base64Url(crypto.getRandomValues(new Uint8Array(18))),
  });
  return json(request, {
    client_id: clientId,
    client_id_issued_at: now,
    redirect_uris: redirectUris,
    client_name: clientName,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201, { 'Cache-Control': 'no-store' });
}

async function handleAuthorize(request: Request): Promise<Response> {
  const limited = await oauthBudget(request);
  if (limited) return limited;
  if (request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const client = await oauthClient(clientId);
    const resource = mcpBaseUrl(request);
    const scope = params.get('scope')?.trim() || HOSTED_MCP_OAUTH_SCOPE;
    if (!client || params.get('response_type') !== 'code' || !(await clientAllowsRedirect(client, redirectUri))) return oauthError(request, 'invalid_request', 'The OAuth authorization request is invalid.');
    if (!params.get('state') || params.get('state')!.length > 4096) return oauthError(request, 'invalid_request', 'A valid state parameter is required.');
    if (!params.get('code_challenge') || params.get('code_challenge_method') !== 'S256' || params.get('code_challenge')!.length > 256) return oauthError(request, 'invalid_request', 'PKCE S256 is required.');
    if (scope.length > 512 || !hostedMcpOAuthScopes(scope, HOSTED_MCP_PROFILE)) return oauthError(request, 'invalid_scope', 'The requested OAuth scope is not supported.');
    return consentRedirect(request, { clientId, clientName: client.clientName, redirectUri, state: params.get('state')!, codeChallenge: params.get('code_challenge')!, scope, resource });
  }

  if (request.method !== 'POST') return oauthError(request, 'invalid_request', 'The authorization endpoint only accepts GET and POST.');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(request, 'invalid_request', 'The authorization request must use form encoding.');
  }
  const clientId = String(form.get('client_id') ?? '');
  const redirectUri = String(form.get('redirect_uri') ?? '');
  const state = String(form.get('state') ?? '');
  const client = await oauthClient(clientId);
  if (!client || !(await clientAllowsRedirect(client, redirectUri))) return oauthError(request, 'invalid_request', 'The OAuth authorization request is invalid.');
  if (form.get('decision') !== 'approve') return authorizationRedirect(request, redirectUri, { error: 'access_denied', state, iss: mcpBaseUrl(request) });
  const qnotesToken = String(form.get('qnotes_token') ?? '');
  if (!isPersonalToken(qnotesToken)) return oauthError(request, 'access_denied', 'A valid QNotes personal token is required.');
  const codeChallenge = String(form.get('code_challenge') ?? '');
  if (!state || state.length > 4096 || !codeChallenge || form.get('code_challenge_method') !== 'S256' || codeChallenge.length > 256) return oauthError(request, 'invalid_request', 'PKCE S256 and state are required.');
  const resource = mcpBaseUrl(request);
  const scope = String(form.get('scope') ?? HOSTED_MCP_OAUTH_SCOPE).slice(0, 512);
  if (!hostedMcpOAuthScopes(scope, HOSTED_MCP_PROFILE)) return oauthError(request, 'invalid_scope', 'The requested OAuth scope is not supported.');
  const grant = await createOAuthGrant(qnotesToken, clientId, resource, scope);
  if (grant === 'denied') return oauthError(request, 'access_denied', 'The personal token cannot provide the requested OAuth access.');
  if (grant === 'unavailable') return oauthError(request, 'temporarily_unavailable', 'OAuth access could not be verified. Retry later.', 503);
  const code = await signOAuthValue('qoc', {
    type: 'authorization_code',
    codeId: crypto.randomUUID(),
    clientId,
    redirectUri,
    codeChallenge,
    scope,
    resource,
    grantId: grant,
    expiresAt: Math.floor(Date.now() / 1000) + OAUTH_CODE_TTL_SECONDS,
  });
  return authorizationRedirect(request, redirectUri, { code, state, iss: mcpBaseUrl(request) });
}

async function handleToken(request: Request): Promise<Response> {
  const limited = await oauthBudget(request);
  if (limited) return limited;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(request, 'invalid_request', 'The token request must use form encoding.');
  }

  const clientId = String(form.get('client_id') ?? basicClientId(request) ?? '');
  const client = await oauthClient(clientId);
  if (!client) return oauthError(request, 'invalid_client', 'The OAuth client credentials are invalid.', 401);
  if (form.get('grant_type') !== 'authorization_code') return oauthError(request, 'unsupported_grant_type', 'Only the authorization_code grant is supported.');

  const codeValue = String(form.get('code') ?? '');
  const code = await verifyOAuthValue<OAuthCodePayload>(codeValue, 'qoc');
  if (!code || code.type !== 'authorization_code' || !isUUID(code.codeId) || !isUUID(code.grantId) || code.clientId !== clientId || code.expiresAt <= Math.floor(Date.now() / 1000)) {
    return oauthError(request, 'invalid_grant', 'The authorization code is invalid or expired.');
  }
  const requestedRedirectUri = form.get('redirect_uri');
  if (requestedRedirectUri === null || String(requestedRedirectUri) !== code.redirectUri || !(await clientAllowsRedirect(client, code.redirectUri))) return oauthError(request, 'invalid_grant', 'The redirect URI does not match the authorization code.');
  if (code.resource !== mcpBaseUrl(request)) return oauthError(request, 'invalid_target', 'The resource does not match this MCP server.');
  const verifier = String(form.get('code_verifier') ?? '');
  if (!verifier || (await pkceChallenge(verifier)) !== code.codeChallenge) return oauthError(request, 'invalid_grant', 'The PKCE verifier is invalid.');
  const grantContext = await oauthGrantContext(code.grantId, code.clientId, code.resource);
  if (!grantContext) return oauthError(request, 'temporarily_unavailable', 'OAuth access could not be verified. Retry later.', 503);
  if (grantContext.length !== 1) return oauthError(request, 'invalid_grant', 'The authorization grant is invalid or expired.');
  const grantExpiresAt = Date.parse(grantContext[0].expires_at);
  const accessExpiresAt = Math.min(Math.floor(Date.now() / 1000) + OAUTH_ACCESS_TTL_SECONDS, Math.floor(grantExpiresAt / 1000));
  if (!Number.isFinite(grantExpiresAt) || accessExpiresAt <= Math.floor(Date.now() / 1000)) return oauthError(request, 'invalid_grant', 'The authorization grant is invalid or expired.');
  if (!(await consumeAuthorizationCode(code.codeId, code.expiresAt))) return oauthError(request, 'invalid_grant', 'The authorization code is invalid or expired.');

  const accessToken = await signOAuthValue('qoa', {
    type: 'access_token',
    clientId,
    resource: code.resource,
    grantId: code.grantId,
    expiresAt: accessExpiresAt,
  });

  return json(request, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessExpiresAt - Math.floor(Date.now() / 1000),
    scope: code.scope,
  }, 200, {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
}

async function handleRevoke(request: Request): Promise<Response> {
  const limited = await oauthBudget(request);
  if (limited) return limited;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(request, 'invalid_request', 'The revocation request must use form encoding.');
  }
  const token = String(form.get('token') ?? '');
  if (!isOAuthAccessToken(token)) return oauthError(request, 'unsupported_token_type', 'Only QNotes OAuth access tokens can be revoked.');
  const access = await verifyOAuthAccessToken(token);
  const resource = mcpBaseUrl(request);
  if (!access || access.resource !== resource) return oauthError(request, 'invalid_token', 'The OAuth access token is invalid.');
  const clientId = String(form.get('client_id') ?? access.clientId);
  if (clientId !== access.clientId || !(await oauthClient(clientId))) return oauthError(request, 'invalid_client', 'The OAuth client credentials are invalid.', 401);
  const revoked = await revokeOAuthGrant(access.grantId, clientId, resource);
  if (revoked === null) return oauthError(request, 'temporarily_unavailable', 'OAuth access could not be revoked. Retry later.', 503);
  return json(request, null, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
}

async function resolveBearerToken(request: Request): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) return null;
  if (isPersonalToken(token)) return token;
  const access = await verifyOAuthAccessToken(token);
  if (!access || access.type !== 'access_token' || access.expiresAt <= Math.floor(Date.now() / 1000) || access.resource !== mcpBaseUrl(request)) return null;
  return token;
}

async function handle(request: Request): Promise<Response> {
  const path = requestPath(request);
  if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));
  const maxBodyBytes = (path === '/register' || path === '/api/oauth/register') && request.method === 'POST'
    ? MAX_OAUTH_REGISTER_BODY_BYTES
    : (path === '/authorize' || path === '/token' || path === '/api/oauth/token' || path === '/revoke') && request.method === 'POST'
      ? MAX_OAUTH_FORM_BODY_BYTES
      : MCP_PATHS.has(path) && request.method === 'POST'
        ? MAX_MCP_REQUEST_BODY_BYTES
        : null;
  if (maxBodyBytes !== null) {
    try {
      request = await boundedRequest(request, maxBodyBytes);
    } catch (error) {
      if (!(error instanceof RequestBodyTooLarge)) throw error;
      if (path === '/register' || path === '/api/oauth/register' || path === '/authorize' || path === '/token' || path === '/api/oauth/token' || path === '/revoke') return oauthError(request, 'invalid_request', 'The request body is too large.', 413);
      return json(request, { error: 'Request body is too large.' }, 413, { 'Cache-Control': 'no-store' });
    }
  }
  if (path === '/health' && request.method === 'GET') return json(request, { status: 'ok' });
  if ((path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') && request.method === 'GET') return json(request, oauthMetadata(request));
  if ((path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') return json(request, oauthResourceMetadata(request));
  if ((path === '/register' || path === '/api/oauth/register') && request.method === 'POST') return handleRegister(request);
  if (path === '/authorize' && request.method === 'GET') return handleAuthorize(request);
  if (path === '/authorize' && request.method === 'POST') return handleAuthorize(request);
  if ((path === '/token' || path === '/api/oauth/token') && request.method === 'POST') return handleToken(request);
  if (path === '/revoke' && request.method === 'POST') return handleRevoke(request);
  if (!MCP_PATHS.has(path)) return json(request, { error: 'Not found' }, 404);

  const token = await resolveBearerToken(request);
  if (!token) {
    return json(request, { error: 'Bearer authentication is required.' }, 401, {
      'WWW-Authenticate': `Bearer realm="qnotes-mcp", resource_metadata="${mcpBaseUrl(request)}/.well-known/oauth-protected-resource", scope="${HOSTED_MCP_OAUTH_SCOPE}"`,
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return json(request, { error: 'Supabase URL is not configured.' }, 500);

  const client = new QNotesClient({
    baseUrl: `${supabaseUrl.replace(/\/$/, '')}/functions/v1/qnotes-api`,
    getAccessToken: () => token,
  });
  const server = createQNotesMcpServer(client, HOSTED_MCP_PROFILE);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return withCors(request, await transport.handleRequest(request));
}

Deno.serve((request) => handle(request).catch(() => {
  console.error('qnotes-mcp request failed');
  return json(request, { error: 'MCP request failed.' }, 500);
}));
