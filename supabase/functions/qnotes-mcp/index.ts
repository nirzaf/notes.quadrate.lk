import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { QNotesClient } from '@qnotes/api-client';
import { createQNotesMcpServer } from '../_shared/generated/mcp-server/server.ts';
import { isPersonalToken } from '../_shared/token.ts';

const MCP_PATHS = new Set(['', '/', '/mcp']);
const STATIC_OAUTH_CLIENT_ID = Deno.env.get('QNOTES_MCP_OAUTH_CLIENT_ID') ?? 'qnotes-gemini';
const OAUTH_SCOPE = 'ACCESS_VIEW_MANAGE_MCP_CONTENT';
const OAUTH_CODE_TTL_SECONDS = 90;
const OAUTH_ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_CLIENT_TTL_SECONDS = 90 * 24 * 60 * 60;
const GOOGLE_REDIRECT_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
]);

interface OAuthCodePayload {
  type: 'authorization_code';
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  encryptedToken: string;
  expiresAt: number;
}

interface OAuthClientPayload {
  type: 'client';
  redirectUriHashes: string[];
  clientName: string;
  expiresAt: number;
  nonce: string;
}

interface OAuthAccessPayload {
  type: 'access_token';
  clientId: string;
  resource: string;
  encryptedToken: string;
  expiresAt: number;
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

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function oauthKey(): Promise<CryptoKey> {
  const pepper = Deno.env.get('QNOTES_TOKEN_PEPPER');
  if (!pepper) throw new Error('QNOTES_TOKEN_PEPPER is not configured.');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function oauthEncryptionKey(): Promise<CryptoKey> {
  const pepper = Deno.env.get('QNOTES_TOKEN_PEPPER');
  if (!pepper) throw new Error('QNOTES_TOKEN_PEPPER is not configured.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pepper));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecret(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await oauthEncryptionKey(),
    new TextEncoder().encode(value),
  ));
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.byteLength);
  return base64Url(combined);
}

async function decryptSecret(value: string): Promise<string | null> {
  try {
    const combined = decodeBase64Url(value);
    if (combined.byteLength <= 12) return null;
    const iv = new Uint8Array(combined.slice(0, 12)) as Uint8Array<ArrayBuffer>;
    const ciphertext = new Uint8Array(combined.slice(12)) as Uint8Array<ArrayBuffer>;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      await oauthEncryptionKey(),
      ciphertext,
    );
    const token = new TextDecoder().decode(plaintext);
    return isPersonalToken(token) ? token : null;
  } catch {
    return null;
  }
}

async function signOAuthValue(prefix: string, payload: Record<string, unknown>): Promise<string> {
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await oauthKey(), new TextEncoder().encode(encodedPayload)));
  return `${prefix}.${encodedPayload}.${base64Url(signature)}`;
}

async function verifyOAuthValue<T>(value: string, prefix: string): Promise<T | null> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  try {
    const signature = new Uint8Array(decodeBase64Url(parts[2])) as Uint8Array<ArrayBuffer>;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await oauthKey(),
      signature,
      new TextEncoder().encode(parts[1]),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]))) as T;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function redirectFingerprint(uri: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uri));
  return base64Url(new Uint8Array(digest).slice(0, 12));
}

function isAllowedGoogleRedirect(uri: string): boolean {
  try {
    const redirect = new URL(uri);
    return redirect.protocol === 'https:' && GOOGLE_REDIRECT_HOSTS.has(redirect.hostname) && !redirect.hash;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function oauthError(request: Request, error: string, description: string, status = 400): Response {
  return json(request, { error, error_description: description }, status, {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
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
    scopes_supported: [OAUTH_SCOPE],
  };
}

function oauthResourceMetadata(request: Request): Record<string, unknown> {
  const base = mcpBaseUrl(request);
  return {
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
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
    return { type: 'client', redirectUriHashes: [], clientName: 'Google', expiresAt: Number.MAX_SAFE_INTEGER, nonce: 'static' };
  }
  const client = await verifyOAuthValue<OAuthClientPayload>(clientId, 'qdc');
  if (!client || client.type !== 'client' || client.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  if (!Array.isArray(client.redirectUriHashes) || client.redirectUriHashes.length === 0 || client.redirectUriHashes.length > 16 || !client.redirectUriHashes.every((hash) => typeof hash === 'string' && /^[A-Za-z0-9_-]{16}$/.test(hash))) return null;
  return client;
}

async function clientAllowsRedirect(client: OAuthClientPayload, redirectUri: string): Promise<boolean> {
  if (!isAllowedGoogleRedirect(redirectUri)) return false;
  return client.redirectUriHashes.length === 0 || client.redirectUriHashes.includes(await redirectFingerprint(redirectUri));
}

function htmlResponse(request: Request, html: string): Response {
  return withCors(request, new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
    },
  }));
}

function consentPage(request: Request, data: { clientId: string; clientName: string; redirectUri: string; state: string; codeChallenge: string; scope: string; resource: string }): Response {
  const fields = [
    hiddenInput('client_id', data.clientId),
    hiddenInput('redirect_uri', data.redirectUri),
    hiddenInput('state', data.state),
    hiddenInput('code_challenge', data.codeChallenge),
    hiddenInput('code_challenge_method', 'S256'),
    hiddenInput('scope', data.scope),
    hiddenInput('resource', data.resource),
  ].join('');
  return htmlResponse(request, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Quadrate Notes</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#151b2e;border:1px solid #263049;border-radius:14px;padding:2rem;max-width:460px;width:calc(100% - 2rem);box-sizing:border-box}h1{font-size:1.2rem;margin:0 0 .6rem}p{color:#9fb0c7;font-size:.92rem;line-height:1.5}label{display:block;font-size:.86rem;color:#cbd5e1;margin-top:1.25rem;margin-bottom:.4rem}input[type=password]{width:100%;padding:.7rem;border-radius:8px;border:1px solid #3b4863;background:#0b1020;color:#fff;box-sizing:border-box;font-size:.95rem}.row{display:flex;gap:.75rem;margin-top:1.5rem}button{flex:1;padding:.72rem;border-radius:8px;border:0;font-size:.95rem;cursor:pointer}.approve{background:#3b82f6;color:#fff}.deny{background:transparent;color:#cbd5e1;border:1px solid #3b4863}code{word-break:break-all;font-size:.8rem}</style></head>
<body><main class="card"><h1>Connect Quadrate Notes</h1><p><strong>${escapeHtml(data.clientName)}</strong> is requesting read-only access to your <strong>Quadrate Notes</strong> MCP tools.</p><p>Enter the personal token you created in Quadrate Notes. It remains protected by the server and is not included in the authorization URL.</p>
<form method="post" action="">${fields}<label for="qnotes-token">Quadrate Notes personal token</label><input id="qnotes-token" name="qnotes_token" type="password" autocomplete="off" placeholder="qnt_…" required autofocus><div class="row"><button class="approve" name="decision" value="approve" type="submit">Approve &amp; Connect</button><button class="deny" name="decision" value="deny" type="submit">Cancel</button></div></form></main></body></html>`);
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
  if (request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const client = await oauthClient(clientId);
    const resource = mcpBaseUrl(request);
    const scope = params.get('scope')?.trim() || OAUTH_SCOPE;
    if (!client || params.get('response_type') !== 'code' || !(await clientAllowsRedirect(client, redirectUri))) return oauthError(request, 'invalid_request', 'The OAuth authorization request is invalid.');
    if (!params.get('state') || params.get('state')!.length > 4096) return oauthError(request, 'invalid_request', 'A valid state parameter is required.');
    if (!params.get('code_challenge') || params.get('code_challenge_method') !== 'S256' || params.get('code_challenge')!.length > 256) return oauthError(request, 'invalid_request', 'PKCE S256 is required.');
    if (scope.length > 512) return oauthError(request, 'invalid_request', 'The OAuth scope is invalid.');
    return consentPage(request, { clientId, clientName: client.clientName, redirectUri, state: params.get('state')!, codeChallenge: params.get('code_challenge')!, scope, resource });
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
  if (!isPersonalToken(qnotesToken)) return oauthError(request, 'access_denied', 'A valid Quadrate Notes personal token is required.');
  const codeChallenge = String(form.get('code_challenge') ?? '');
  if (!state || state.length > 4096 || !codeChallenge || form.get('code_challenge_method') !== 'S256' || codeChallenge.length > 256) return oauthError(request, 'invalid_request', 'PKCE S256 and state are required.');
  const resource = mcpBaseUrl(request);
  const scope = String(form.get('scope') ?? OAUTH_SCOPE).slice(0, 512);
  const code = await signOAuthValue('qoc', {
    type: 'authorization_code',
    clientId,
    redirectUri,
    codeChallenge,
    scope,
    resource,
    encryptedToken: await encryptSecret(qnotesToken),
    expiresAt: Math.floor(Date.now() / 1000) + OAUTH_CODE_TTL_SECONDS,
  });
  return authorizationRedirect(request, redirectUri, { code, state, iss: mcpBaseUrl(request) });
}

async function handleToken(request: Request): Promise<Response> {
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
  if (!code || code.type !== 'authorization_code' || code.clientId !== clientId || code.expiresAt <= Math.floor(Date.now() / 1000)) {
    return oauthError(request, 'invalid_grant', 'The authorization code is invalid or expired.');
  }
  const requestedRedirectUri = form.get('redirect_uri');
  if (requestedRedirectUri !== null && String(requestedRedirectUri) !== code.redirectUri) return oauthError(request, 'invalid_grant', 'The redirect URI does not match the authorization code.');
  if (code.resource !== mcpBaseUrl(request)) return oauthError(request, 'invalid_target', 'The resource does not match this MCP server.');
  const verifier = String(form.get('code_verifier') ?? '');
  if (!verifier || (await pkceChallenge(verifier)) !== code.codeChallenge) return oauthError(request, 'invalid_grant', 'The PKCE verifier is invalid.');

  const accessToken = await signOAuthValue('qoa', {
    type: 'access_token',
    clientId,
    resource: code.resource,
    encryptedToken: code.encryptedToken,
    expiresAt: Math.floor(Date.now() / 1000) + OAUTH_ACCESS_TTL_SECONDS,
  });

  return json(request, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TTL_SECONDS,
    scope: code.scope,
  }, 200, {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
}

async function resolveBearerToken(request: Request): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) return null;
  if (isPersonalToken(token)) return token;
  const access = await verifyOAuthValue<OAuthAccessPayload>(token, 'qoa');
  if (!access || access.type !== 'access_token' || access.expiresAt <= Math.floor(Date.now() / 1000) || access.resource !== mcpBaseUrl(request)) return null;
  return decryptSecret(access.encryptedToken);
}

async function handle(request: Request): Promise<Response> {
  const path = requestPath(request);
  if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));
  if (path === '/health' && request.method === 'GET') return json(request, { status: 'ok' });
  if (path === '/.well-known/oauth-authorization-server' && request.method === 'GET') return json(request, oauthMetadata(request));
  if ((path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') return json(request, oauthResourceMetadata(request));
  if ((path === '/register' || path === '/api/oauth/register') && request.method === 'POST') return handleRegister(request);
  if (path === '/authorize' && request.method === 'GET') return handleAuthorize(request);
  if (path === '/authorize' && request.method === 'POST') return handleAuthorize(request);
  if ((path === '/token' || path === '/api/oauth/token') && request.method === 'POST') return handleToken(request);
  if (!MCP_PATHS.has(path)) return json(request, { error: 'Not found' }, 404);

  const token = await resolveBearerToken(request);
  if (!token) {
    return json(request, { error: 'Bearer authentication is required.' }, 401, {
      'WWW-Authenticate': `Bearer realm="quadrate-notes-mcp", resource_metadata="${mcpBaseUrl(request)}/.well-known/oauth-protected-resource", scope="${OAUTH_SCOPE}"`,
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return json(request, { error: 'Supabase URL is not configured.' }, 500);

  const client = new QNotesClient({
    baseUrl: `${supabaseUrl.replace(/\/$/, '')}/functions/v1/qnotes-api`,
    getAccessToken: () => token,
  });
  const server = createQNotesMcpServer(client, 'read');
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return withCors(request, await transport.handleRequest(request));
}

Deno.serve((request) => handle(request).catch((error) => {
  console.error('qnotes-mcp request failed', error instanceof Error ? error.message : 'unknown error');
  return json(request, { error: 'MCP request failed.' }, 500);
}));
