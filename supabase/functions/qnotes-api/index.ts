import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isUUID } from '@qnotes/shared';
import { authenticateRequest, type AuthContext } from '../_shared/auth.ts';
import { applyCors } from '../_shared/cors.ts';
import { errorBody } from '../_shared/errors.ts';
import { ApiError } from '../_shared/errors.ts';
import { listNotes, getNote, createNote, updateNote, appendNote, moveNoteToNotebook, deleteNote, restoreNote } from './notes.ts';
import { listBlocks, getBlock } from './blocks.ts';
import { searchNotes } from './search.ts';
import { getNoteContext, postNoteContext } from './context.ts';
import { syncNotes } from './sync.ts';
import { listAttachments, requestUpload, finalizeAttachment, getDownloadUrl, deleteAttachment } from './attachments.ts';
import { listTokens, createToken, revokeToken } from './tokens.ts';
import { exportNote, exportWorkspace } from './exports.ts';
import { listNotebooks, createNotebook } from './notebooks.ts';
import { createPublicShare, getPublicShare, resolvePublicShare, resolvePublicShareMarkdown, revokePublicShare } from './shares.ts';

interface Variables {
  auth: AuthContext;
  requestId: string;
}

const app = new Hono<{ Variables: Variables }>();

app.use('*', async (context, next) => {
  const incoming = context.req.header('x-request-id');
  const requestId = incoming && isUUID(incoming) ? incoming : crypto.randomUUID();
  context.set('requestId', requestId);
  context.header('x-request-id', requestId);
  const corsHeaders = new Headers();
  const publicMarkdownRequest = context.req.path === '/public/share/resolve' && (context.req.method === 'GET' || context.req.method === 'OPTIONS');
  if (publicMarkdownRequest) {
    corsHeaders.set('Access-Control-Allow-Origin', '*');
    corsHeaders.set('Access-Control-Allow-Headers', 'content-type');
    corsHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    corsHeaders.set('Access-Control-Expose-Headers', 'content-disposition, x-request-id');
  } else {
    applyCors(context.req.raw, corsHeaders);
  }
  for (const [key, value] of corsHeaders) context.header(key, value);
  if (context.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const started = performance.now();
  try {
    await next();
  } finally {
    const auth = context.get('auth');
    console.info(JSON.stringify({ requestId, method: context.req.method, route: context.req.path, status: context.res.status, authKind: auth?.authKind ?? 'none', userId: auth?.userId ?? null, duration: Math.round(performance.now() - started) }));
  }
  context.res.headers.set('x-request-id', requestId);
  return context.res;
});

app.use('/api/*', async (context, next) => {
  if (context.req.path === '/api/health') return next();
  const auth = await authenticateRequest(context.req.raw);
  context.set('auth', auth);
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

app.onError((error, context) => {
  const apiError = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
  const requestId = context.get('requestId') ?? crypto.randomUUID();
  const response = context.json(errorBody(apiError, requestId), apiError.status as 500);
  response.headers.set('x-request-id', requestId);
  if (context.req.path === '/public/share/resolve') {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (context.req.method === 'GET') {
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Expose-Headers', 'content-disposition, x-request-id');
    }
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
app.post('/public/share/resolve', bodyLimit({
  maxSize: 1024,
  onError: (context) => {
    context.header('Cache-Control', 'no-store');
    context.header('Pragma', 'no-cache');
    context.header('X-Content-Type-Options', 'nosniff');
    return context.json(errorBody(new ApiError(413, 'VALIDATION_ERROR', 'The public share request is too large.'), context.get('requestId') ?? crypto.randomUUID()), 413);
  },
}), resolvePublicShare);
app.get('/public/share/resolve', resolvePublicShareMarkdown);
app.get('/api/export/note/:noteRef', exportNote);
app.get('/api/export/workspace', exportWorkspace);

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
