import assert from 'node:assert/strict';
import test from 'node:test';

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:54321');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'local-test-service-role-key');

const { findOwnedNoteIdentity } = await import('./notes.ts');

const ownerId = '660e8400-e29b-41d4-a716-446655440000';
const otherOwnerId = '770e8400-e29b-41d4-a716-446655440000';
const noteId = '550e8400-e29b-41d4-a716-446655440000';
const otherOwnerNoteId = '550e8400-e29b-41d4-a716-446655440001';
const deletedNoteId = '550e8400-e29b-41d4-a716-446655440002';

interface NoteRow {
  id: string;
  owner_id: string;
  slug: string;
  deleted_at: string | null;
  content_markdown: string;
}

function identityDatabase(rows: readonly NoteRow[]) {
  const calls: string[] = [];
  const filters: Array<(row: NoteRow) => boolean> = [];
  let columns = '*';
  const query = {
    select(nextColumns: string) {
      columns = nextColumns;
      calls.push(`select:${columns}`);
      return query;
    },
    eq(column: string, value: string) {
      calls.push(`eq:${column}:${value}`);
      filters.push((row) => row[column as keyof NoteRow] === value);
      return query;
    },
    is(column: string, value: null) {
      calls.push(`is:${column}:${value}`);
      filters.push((row) => row[column as keyof NoteRow] === value);
      return query;
    },
    limit(count: number) {
      calls.push(`limit:${count}`);
      return query;
    },
    async maybeSingle() {
      const row = rows.find((candidate) => filters.every((filter) => filter(candidate)));
      return { data: row && columns === 'id' ? { id: row.id } : row ?? null, error: null };
    },
  };
  return {
    database: {
      from(table: string) {
        calls.push(`from:${table}`);
        return query;
      },
    },
    calls,
  };
}

test('attachment ownership lookup selects only the note identity', async () => {
  const mock = identityDatabase([{
    id: noteId,
    owner_id: ownerId,
    slug: 'performance-note',
    deleted_at: null,
    content_markdown: 'full note body must not be selected',
  }]);

  const result = await findOwnedNoteIdentity(ownerId, noteId, false, mock.database);

  assert.deepEqual(result, { id: noteId });
  assert.deepEqual(mock.calls, [
    'from:notes',
    'select:id',
    `eq:owner_id:${ownerId}`,
    'limit:1',
    `eq:id:${noteId}`,
    'is:deleted_at:null',
  ]);
});

test('resolves UUID and normalized slug references for the owner', async () => {
  const rows = [{
    id: noteId,
    owner_id: ownerId,
    slug: 'performance-note',
    deleted_at: null,
    content_markdown: 'private note body',
  }];

  const uuidLookup = identityDatabase(rows);
  assert.deepEqual(await findOwnedNoteIdentity(ownerId, noteId, false, uuidLookup.database), { id: noteId });
  assert.ok(uuidLookup.calls.includes(`eq:id:${noteId}`));

  const slugLookup = identityDatabase(rows);
  assert.deepEqual(await findOwnedNoteIdentity(ownerId, ' Performance-Note ', false, slugLookup.database), { id: noteId });
  assert.ok(slugLookup.calls.includes('eq:slug:performance-note'));
  assert.ok(slugLookup.calls.includes('is:deleted_at:null'));
});

test('returns the existing note-not-found error for wrong-owner, missing, and deleted notes', async () => {
  const rows: NoteRow[] = [
    { id: noteId, owner_id: ownerId, slug: 'performance-note', deleted_at: null, content_markdown: 'private note body' },
    { id: otherOwnerNoteId, owner_id: otherOwnerId, slug: 'other-owner-note', deleted_at: null, content_markdown: 'other private note body' },
    { id: deletedNoteId, owner_id: ownerId, slug: 'deleted-note', deleted_at: '2026-09-08T00:00:00.000Z', content_markdown: 'deleted private note body' },
  ];

  for (const [label, lookupOwner, reference] of [
    ['wrong owner', otherOwnerId, noteId],
    ['missing note', ownerId, '550e8400-e29b-41d4-a716-446655440099'],
    ['deleted note', ownerId, deletedNoteId],
  ] as const) {
    const mock = identityDatabase(rows);
    await assert.rejects(
      findOwnedNoteIdentity(lookupOwner, reference, false, mock.database),
      (error: unknown) => error instanceof Error
        && error.name === 'ApiError'
        && (error as { status?: unknown }).status === 404
        && (error as { code?: unknown }).code === 'NOTE_NOT_FOUND',
      `${label} must remain hidden from attachment listing`,
    );
    assert.ok(mock.calls.includes(`eq:owner_id:${lookupOwner}`));
    assert.ok(mock.calls.includes('is:deleted_at:null'));
    assert.ok(mock.calls.includes('select:id'));
  }
});
