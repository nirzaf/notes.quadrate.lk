import assert from 'node:assert/strict';
import test from 'node:test';

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:54321');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'local-test-service-role-key');

const { noteFromRow, summaryFromRow } = await import('./database.ts');

const baseRow = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  slug: 'performance-note',
  title: 'Performance note',
  content_markdown: '# Full Markdown body',
  content_plain: 'Plain excerpt for the note',
  tags: ['performance', 'notes'],
  notebook_id: null,
  version: 7,
  created_at: '2026-09-09T00:00:00.000Z',
  updated_at: '2026-09-09T01:00:00.000Z',
  deleted_at: null,
  owner_id: '660e8400-e29b-41d4-a716-446655440000',
  mutation_id: '770e8400-e29b-41d4-a716-446655440000',
  arbitrary_row_field: 'must not leak',
};

test('serializes a note summary with exactly the documented fields', () => {
  assert.equal(JSON.stringify(summaryFromRow(baseRow)), JSON.stringify({
    id: baseRow.id,
    slug: baseRow.slug,
    title: baseRow.title,
    excerpt: baseRow.content_plain,
    tags: baseRow.tags,
    notebookId: baseRow.notebook_id,
    version: baseRow.version,
    createdAt: baseRow.created_at,
    updatedAt: baseRow.updated_at,
    deletedAt: baseRow.deleted_at,
  }));
  assert.equal('contentMarkdown' in summaryFromRow(baseRow), false);
  assert.equal('contentPlain' in summaryFromRow(baseRow), false);
  assert.equal('owner_id' in summaryFromRow(baseRow), false);
  assert.equal('mutation_id' in summaryFromRow(baseRow), false);
  assert.equal('arbitrary_row_field' in summaryFromRow(baseRow), false);
});

test('keeps long-note summary JSON bounded while full-note retrieval stays complete', () => {
  const excerpt = 'deterministic excerpt '.repeat(12).slice(0, 180);
  const longMarkdown = `# Long note\n\n${'markdown body '.repeat(10_000)}`;
  const longPlain = `${excerpt}${' plain body'.repeat(10_000)}`;
  const shortRow = { ...baseRow, content_markdown: '# Short note', content_plain: excerpt };
  const longRow = { ...baseRow, content_markdown: longMarkdown, content_plain: longPlain };

  assert.equal(JSON.stringify(summaryFromRow(longRow)).length, JSON.stringify(summaryFromRow(shortRow)).length);
  assert.equal(noteFromRow(longRow).contentMarkdown, longMarkdown);
  assert.equal(noteFromRow(longRow).contentPlain, longPlain);
});
