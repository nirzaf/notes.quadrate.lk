const ROUTES: Array<[RegExp, string]> = [
  [/^\/api\/notes\/[^/]+\/blocks\/[^/]+$/, '/api/notes/:noteRef/blocks/:blockKey'],
  [/^\/api\/notes\/[^/]+\/attachments$/, '/api/notes/:noteRef/attachments'],
  [/^\/api\/notes\/[^/]+\/append$/, '/api/notes/:noteId/append'],
  [/^\/api\/notes\/[^/]+\/notebook$/, '/api/notes/:noteId/notebook'],
  [/^\/api\/notes\/[^/]+\/restore$/, '/api/notes/:noteId/restore'],
  [/^\/api\/notes\/[^/]+\/share$/, '/api/notes/:noteId/share'],
  [/^\/api\/notes\/[^/]+$/, '/api/notes/:noteRef'],
  [/^\/api\/attachments\/[^/]+$/, '/api/attachments/:attachmentId'],
  [/^\/api\/tokens\/[^/]+$/, '/api/tokens/:tokenId'],
  [/^\/api\/search\/documents\/[^/]+\/context$/, '/api/search/documents/:documentId/context'],
  [/^\/api\/export\/note\/[^/]+$/, '/api/export/note/:noteRef'],
];

export function normalizeApiRoute(path: string): string {
  const pathname = path.split('?')[0] ?? path;
  for (const [pattern, template] of ROUTES) {
    if (pattern.test(pathname)) return template;
  }
  if (pathname === '/api/health' || pathname === '/api/notes' || pathname === '/api/notebooks' || pathname === '/api/search' || pathname === '/api/context' || pathname === '/api/sync' || pathname === '/api/tokens' || pathname === '/public/share/resolve' || pathname === '/api/export/workspace' || pathname === '/api/import/workspace') return pathname;
  return pathname.startsWith('/api/') ? '/api/*' : '/unmatched';
}

export function requestRoute(context: { req: { path: string; routePath?: string } }): string {
  const routePath = context.req.routePath;
  if (routePath && routePath !== '/*' && !routePath.includes('*')) return routePath;
  return normalizeApiRoute(context.req.path);
}
