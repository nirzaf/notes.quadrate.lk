import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { QNotesClient } from '@qnotes/api-client';
import { createQNotesMcpServer } from '../_shared/generated/mcp-server/server.ts';

const MCP_PATHS = new Set(['', '/', '/mcp']);

function requestPath(request: Request): string {
  const path = new URL(request.url).pathname.replace(/^\/qnotes-mcp(?=\/|$)/, '');
  return path === '/' ? '/' : path;
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

async function handle(request: Request): Promise<Response> {
  const path = requestPath(request);
  if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));
  if (path === '/health' && request.method === 'GET') return json(request, { status: 'ok' });
  if (!MCP_PATHS.has(path)) return json(request, { error: 'Not found' }, 404);

  const token = bearerToken(request);
  if (!token) {
    return json(request, { error: 'Bearer authentication is required.' }, 401, {
      'WWW-Authenticate': 'Bearer realm="quadrate-notes-mcp"',
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
