import { Hono } from 'hono';
import { isUUID } from '@qnotes/shared';
import { authenticateRequest, type AuthContext } from '../_shared/auth.ts';
import { applyCors } from '../_shared/cors.ts';
import { errorBody } from '../_shared/errors.ts';
import { ApiError } from '../_shared/errors.ts';
import { requestRoute } from './route-logging.ts';
import { listNotes, getNote, createNote, updateNote, appendNote, moveNoteToNotebook, deleteNote, restoreNote } from './notes.ts';
import { listBlocks, getBlock } from './blocks.ts';
import { searchNotes } from './search.ts';
import { getNoteContext, postNoteContext } from './context.ts';
import { syncNotes } from './sync.ts';
import { listAttachments, requestUpload, finalizeAttachment, getDownloadUrl, deleteAttachment } from './attachments.ts';
import { listTokens, createToken, revokeToken } from './tokens.ts';
import { exportNote, exportWorkspace, workspaceMaxBytes } from './exports.ts';
import { inspectWorkspaceImport } from './imports.ts';
import { listNotebooks, createNotebook } from './notebooks.ts';
import { createPublicShare, getPublicShare, resolvePublicShare, revokePublicShare } from './shares.ts';
import { authenticateVaultRequest, type VaultAuthContext } from '../_shared/vault-auth.ts';
import { createVaultAgentToken, createVaultEnvironment, createVaultProject, createVaultSecret, createVaultSecretBySelector, deleteVaultSecret, getVaultSecret, issueVaultOperationApproval, listVaultAgentTokens, listVaultAudit, listVaultEnvironments, listVaultProjects, listVaultSecrets, listVaultSecretsBySelector, replaceVaultAgentGrants, revealVaultSecret, revealVaultSecrets, revokeVaultAgentToken, rotateVaultSecret } from './vault.ts';
import { boundedRequest, RequestBodyTooLarge } from '../_shared/request-body.ts';
import { enforceRequestBudget, MAX_API_REQUEST_BODY_BYTES, MAX_PUBLIC_SHARE_REQUEST_BODY_BYTES, MAX_VAULT_REQUEST_BODY_BYTES, requestClientPrincipal } from '../_shared/request-limits.ts';

interface Variables {
  auth: AuthContext;
  vaultAuth: VaultAuthContext;
  requestId: string;
  limitDecision: string;
}

const app = new Hono<{ Variables: Variables }>();

app.use('*', async (context, next) => {
  const incoming = context.req.header('x-request-id');
  const requestId = incoming && isUUID(incoming) ? incoming : crypto.randomUUID();
  context.set('requestId', requestId);
  context.header('x-request-id', requestId);
  const corsHeaders = new Headers();
  applyCors(context.req.raw, corsHeaders);
  for (const [key, value] of corsHeaders) context.header(key, value);
  if (context.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const started = performance.now();
  try {
    await next();
  } finally {
    const auth = context.get('auth');
    const vaultAuth = context.get('vaultAuth');
    console.info(JSON.stringify({ requestId, method: context.req.method, route: requestRoute(context), status: context.res.status, authKind: auth?.authKind ?? vaultAuth?.authKind ?? 'none', limitDecision: context.get('limitDecision') ?? 'not_applied', duration: Math.round(performance.now() - started) }));
  }
  context.res.headers.set('x-request-id', requestId);
  return context.res;
});

app.use('*', async (context, next) => {
  const path = context.req.path;
  const maxBytes = path === '/public/share/resolve'
    ? MAX_PUBLIC_SHARE_REQUEST_BODY_BYTES
    : path === '/api/import/workspace'
      ? workspaceMaxBytes()
      : path.startsWith('/vault/')
        ? MAX_VAULT_REQUEST_BODY_BYTES
        : path.startsWith('/api/')
          ? MAX_API_REQUEST_BODY_BYTES
          : null;
  if (maxBytes === null) return next();
  try {
    context.req.raw = await boundedRequest(context.req.raw, maxBytes);
  } catch (error) {
    if (!(error instanceof RequestBodyTooLarge)) throw error;
    context.header('Cache-Control', 'no-store');
    return context.json(errorBody(new ApiError(413, 'REQUEST_TOO_LARGE', 'The request body is too large.'), context.get('requestId') ?? crypto.randomUUID()), 413);
  }
  return next();
});

app.use('/api/*', async (context, next) => {
  if (context.req.path === '/api/health') return next();
  const auth = await authenticateRequest(context.req.raw);
  context.set('auth', auth);
  return next();
});

app.use('/vault/*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Pragma', 'no-cache');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Referrer-Policy', 'no-referrer');
  const auth = await authenticateVaultRequest(context.req.raw);
  context.set('vaultAuth', auth);
  return next();
});

app.use('/api/tokens', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Pragma', 'no-cache');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Referrer-Policy', 'no-referrer');
  return next();
});
app.use('/api/tokens/*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Pragma', 'no-cache');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Referrer-Policy', 'no-referrer');
  return next();
});

app.use('/public/share/resolve', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Pragma', 'no-cache');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  context.header('Referrer-Policy', 'no-referrer');
  context.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  return next();
});

app.use('/public/share/resolve', async (context, next) => {
  await enforceRequestBudget('public-share', requestClientPrincipal(context.req.raw));
  context.set('limitDecision', 'public-share-allowed');
  return next();
});

app.onError((error, context) => {
  const apiError = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
  const requestId = context.get('requestId') ?? crypto.randomUUID();
  const response = context.json(errorBody(apiError, requestId), apiError.status as 500);
  response.headers.set('x-request-id', requestId);
  if (apiError.status === 429) {
    const details = apiError.details && typeof apiError.details === 'object' && !Array.isArray(apiError.details) ? apiError.details as Record<string, unknown> : {};
    const retryAfter = details.retryAfterSeconds;
    if (typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0) response.headers.set('Retry-After', String(retryAfter));
  }
  if (context.req.path === '/public/share/resolve') {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  if (context.req.path.startsWith('/vault/') || context.req.path.startsWith('/api/tokens')) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
  }
  return response;
});

app.get('/api/health', (context) => context.json({ data: { status: 'ok' } }));

app.get('/api/notes', listNotes);
app.get('/api/notes/:noteRef', getNote);
app.post('/api/notes', createNote);
app.patch('/api/notes/:noteId', updateNote);
app.post('/api/notes/:noteId/append', appendNote);
app.patch('/api/notes/:noteId/notebook', moveNoteToNotebook);
app.delete('/api/notes/:noteId', deleteNote);
app.post('/api/notes/:noteId/restore', restoreNote);
app.get('/api/notebooks', listNotebooks);
app.post('/api/notebooks', createNotebook);
app.get('/api/notes/:noteRef/blocks/:blockKey', getBlock);
app.get('/api/notes/:noteRef/blocks', listBlocks);
app.get('/api/search', searchNotes);
app.post('/api/search', searchNotes);
app.get('/api/search/documents/:documentId/context', getNoteContext);
app.post('/api/context', postNoteContext);
app.get('/api/sync', syncNotes);
app.get('/api/notes/:noteRef/attachments', listAttachments);
app.post('/api/attachments/upload-url', requestUpload);
app.post('/api/attachments/:attachmentId/finalize', finalizeAttachment);
app.get('/api/attachments/:attachmentId', getDownloadUrl);
app.delete('/api/attachments/:attachmentId', deleteAttachment);
app.get('/api/tokens', listTokens);
app.post('/api/tokens', createToken);
app.delete('/api/tokens/:tokenId', revokeToken);
app.get('/api/notes/:noteId/share', getPublicShare);
app.post('/api/notes/:noteId/share', createPublicShare);
app.delete('/api/notes/:noteId/share', revokePublicShare);
app.post('/public/share/resolve', resolvePublicShare);
app.get('/api/export/note/:noteRef', exportNote);
app.get('/api/export/workspace', exportWorkspace);
app.post('/api/import/workspace', inspectWorkspaceImport);

app.get('/vault/projects', listVaultProjects);
app.post('/vault/projects', createVaultProject);
app.get('/vault/projects/:projectRef/environments', listVaultEnvironments);
app.post('/vault/projects/:projectRef/environments', createVaultEnvironment);
app.get('/vault/environments/:environmentId/secrets', listVaultSecrets);
app.post('/vault/environments/:environmentId/secrets', createVaultSecret);
app.get('/vault/projects/:projectRef/environments/:environmentRef/secrets', listVaultSecretsBySelector);
app.post('/vault/projects/:projectRef/environments/:environmentRef/secrets', createVaultSecretBySelector);
app.get('/vault/secrets/:secretId', getVaultSecret);
app.patch('/vault/secrets/:secretId', rotateVaultSecret);
app.delete('/vault/secrets/:secretId', deleteVaultSecret);
app.post('/vault/secrets/reveal', revealVaultSecret);
app.post('/vault/secrets/reveal-batch', revealVaultSecrets);
app.post('/vault/approvals', issueVaultOperationApproval);
app.get('/vault/agent-tokens', listVaultAgentTokens);
app.post('/vault/agent-tokens', createVaultAgentToken);
app.delete('/vault/agent-tokens/:tokenId', revokeVaultAgentToken);
app.patch('/vault/agent-tokens/:tokenId/grants', replaceVaultAgentGrants);
app.get('/vault/audit', listVaultAudit);

app.notFound((context) => context.json(errorBody(new ApiError(404, 'NOTE_NOT_FOUND', 'The requested resource was not found.'), context.get('requestId') ?? crypto.randomUUID()), 404));

function normalizeFunctionPath(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === '/qnotes-api' || url.pathname.startsWith('/qnotes-api/')) {
    url.pathname = url.pathname.slice('/qnotes-api'.length) || '/';
    return new Request(url, request);
  }
  return request;
}

Deno.serve((request) => app.fetch(normalizeFunctionPath(request)));
