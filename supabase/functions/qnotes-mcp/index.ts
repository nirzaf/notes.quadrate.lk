import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { QNotesClient } from '@qnotes/api-client';
import { createQNotesMcpServer } from '../_shared/generated/mcp-server/server.ts';
import { isPersonalToken } from '../_shared/token.ts';

const MCP_PATHS = new Set(['', '/', '/mcp']);
const OAUTH_CLIENT_ID = Deno.env.get('QNOTES_MCP_OAUTH_CLIENT_ID') ?? 'qnotes-gemini';
const OAUTH_SCOPE = 'ACCESS_VIEW_MANAGE_MCP_CONTENT';
const OAUTH_CODE_TTL_SECONDS = 90;
const OAUTH_ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
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

function isAllowedGoogleRedirect(uri: string): boolean {
  try {
    const redirect = new URL(uri);
    return redirect.protocol === 'https:' && GOOGLE_REDIRECT_HOSTS.has(redirect.hostname) && !redirect.hash;
  } catch {
    return false;
  }
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
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
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

function basicCredentials(request: Request): { clientId: string; clientSecret: string } | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = new TextDecoder().decode(decodeBase64Url(header.slice(6).trim()));
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function handleAuthorize(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  const resource = params.get('resource') ?? mcpBaseUrl(request);
  const scope = params.get('scope')?.trim() || OAUTH_SCOPE;

  if (clientId !== OAUTH_CLIENT_ID || responseType !== 'code') return oauthError(request, 'invalid_request', 'The OAuth authorization request is invalid.');
  if (!redirectUri || !isAllowedGoogleRedirect(redirectUri)) return oauthError(request, 'invalid_request', 'The redirect URI is not allowed.');
  if (!state || state.length > 2048) return oauthError(request, 'invalid_request', 'A valid state parameter is required.');
  if (!codeChallenge || codeChallengeMethod !== 'S256' || codeChallenge.length > 256) return oauthError(request, 'invalid_request', 'PKCE S256 is required.');
  if (resource !== mcpBaseUrl(request)) return oauthError(request, 'invalid_target', 'The resource does not match this MCP server.');

  const code = await signOAuthValue('qoc', {
    type: 'authorization_code',
    clientId,
    redirectUri,
    codeChallenge,
    scope: scope.slice(0, 512),
    resource,
    expiresAt: Math.floor(Date.now() / 1000) + OAUTH_CODE_TTL_SECONDS,
  });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', state);
  return withCors(request, new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      'Cache-Control': 'no-store',
    },
  }));
}

async function handleToken(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(request, 'invalid_request', 'The token request must use form encoding.');
  }

  const basic = basicCredentials(request);
  const clientId = String(form.get('client_id') ?? basic?.clientId ?? '');
  const clientSecret = String(form.get('client_secret') ?? basic?.clientSecret ?? '');
  if (clientId !== OAUTH_CLIENT_ID || !isPersonalToken(clientSecret)) return oauthError(request, 'invalid_client', 'The OAuth client credentials are invalid.', 401);
  if (form.get('grant_type') !== 'authorization_code') return oauthError(request, 'unsupported_grant_type', 'Only the authorization_code grant is supported.');

  const codeValue = String(form.get('code') ?? '');
  const code = await verifyOAuthValue<OAuthCodePayload>(codeValue, 'qoc');
  if (!code || code.type !== 'authorization_code' || code.clientId !== clientId || code.expiresAt <= Math.floor(Date.now() / 1000)) {
    return oauthError(request, 'invalid_grant', 'The authorization code is invalid or expired.');
  }
  if (String(form.get('redirect_uri') ?? '') !== code.redirectUri) return oauthError(request, 'invalid_grant', 'The redirect URI does not match the authorization code.');
  if (code.resource !== mcpBaseUrl(request)) return oauthError(request, 'invalid_target', 'The resource does not match this MCP server.');
  const verifier = String(form.get('code_verifier') ?? '');
  if (!verifier || (await pkceChallenge(verifier)) !== code.codeChallenge) return oauthError(request, 'invalid_grant', 'The PKCE verifier is invalid.');

  return json(request, {
    access_token: clientSecret,
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TTL_SECONDS,
    scope: code.scope,
  }, 200, {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
}

async function handle(request: Request): Promise<Response> {
  const path = requestPath(request);
  if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));
  if (path === '/health' && request.method === 'GET') return json(request, { status: 'ok' });
  if (path === '/.well-known/oauth-authorization-server' && request.method === 'GET') return json(request, oauthMetadata(request));
  if ((path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') return json(request, oauthResourceMetadata(request));
  if (path === '/authorize' && request.method === 'GET') return handleAuthorize(request);
  if (path === '/token' && request.method === 'POST') return handleToken(request);
  if (!MCP_PATHS.has(path)) return json(request, { error: 'Not found' }, 404);

  const token = bearerToken(request);
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
