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
  [/^\/vault\/projects\/[^/]+\/environments\/[^/]+\/secrets$/, '/vault/projects/:projectRef/environments/:environmentRef/secrets'],
  [/^\/vault\/projects\/[^/]+\/environments$/, '/vault/projects/:projectRef/environments'],
  [/^\/vault\/environments\/resolve$/, '/vault/environments/resolve'],
  [/^\/vault\/environments\/[^/]+\/secrets$/, '/vault/environments/:environmentId/secrets'],
  [/^\/vault\/secrets\/reveal-batch$/, '/vault/secrets/reveal-batch'],
  [/^\/vault\/mutations\/[^/]+$/, '/vault/mutations/:mutationId'],
  [/^\/vault\/secrets\/resolve$/, '/vault/secrets/resolve'],
  [/^\/vault\/secrets\/[^/]+$/, '/vault/secrets/:secretId'],
  [/^\/vault\/agent-tokens\/[^/]+\/grants$/, '/vault/agent-tokens/:tokenId/grants'],
  [/^\/vault\/agent-tokens\/[^/]+$/, '/vault/agent-tokens/:tokenId'],
];

export function normalizeApiRoute(path: string): string {
  const pathname = path.split('?')[0] ?? path;
  for (const [pattern, template] of ROUTES) {
    if (pattern.test(pathname)) return template;
  }
  if (pathname === '/api/health' || pathname === '/api/notes' || pathname === '/api/notebooks' || pathname === '/api/search' || pathname === '/api/context' || pathname === '/api/sync' || pathname === '/api/tokens' || pathname === '/public/share/resolve' || pathname === '/api/export/workspace' || pathname === '/api/import/workspace' || pathname === '/vault/projects' || pathname === '/vault/secrets/reveal' || pathname === '/vault/approvals' || pathname === '/vault/audit' || pathname === '/vault/agent-tokens' || pathname === '/vault/environments/resolve' || pathname === '/vault/secrets/resolve') return pathname;
  if (pathname.startsWith('/api/')) return '/api/*';
  if (pathname.startsWith('/vault/')) return '/vault/*';
  return '/unmatched';
}

export function requestRoute(context: { req: { path: string; routePath?: string } }): string {
  const routePath = context.req.routePath;
  if (routePath && routePath !== '/*' && !routePath.includes('*')) return routePath;
  return normalizeApiRoute(context.req.path);
}
