import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiRoute, requestRoute } from './route-logging.ts';

test('normalizes resource identifiers to route templates', () => {
  assert.equal(normalizeApiRoute('/api/notes/550e8400-e29b-41d4-a716-446655440000'), '/api/notes/:noteRef');
  assert.equal(normalizeApiRoute('/api/notes/550e8400-e29b-41d4-a716-446655440000/share'), '/api/notes/:noteId/share');
  assert.equal(normalizeApiRoute('/api/attachments/550e8400-e29b-41d4-a716-446655440000'), '/api/attachments/:attachmentId');
  assert.equal(normalizeApiRoute('/api/search/documents/550e8400-e29b-41d4-a716-446655440000/context'), '/api/search/documents/:documentId/context');
  assert.equal(normalizeApiRoute('/public/share/resolve'), '/public/share/resolve');
  assert.equal(normalizeApiRoute('/api/import/workspace'), '/api/import/workspace');
  assert.equal(normalizeApiRoute('/api/private/550e8400-e29b-41d4-a716-446655440000'), '/api/*');
});

test('uses verified Hono route templates and safely falls back when unavailable', () => {
  assert.equal(requestRoute({ req: { path: '/api/notes/secret', routePath: '/api/notes/:noteRef' } }), '/api/notes/:noteRef');
  assert.equal(requestRoute({ req: { path: '/api/notes/secret' } }), '/api/notes/:noteRef');
  assert.equal(requestRoute({ req: { path: '/api/notes/secret', routePath: '/*' } }), '/api/notes/:noteRef');
});
