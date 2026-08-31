begin;
select plan(20);

select is(
  (public.qnotes_create_note(
    (select id from auth.users where email = 'owner@qnotes.local'),
    '33333333-3333-4333-8333-333333333333',
    'transaction-note',
    'Transaction Note',
    '# Transaction Note\n\nbody',
    'Transaction Note body',
    '{}',
    '33333333-3333-4333-8333-333333333334',
    '33333333-3333-4333-8333-333333333335',
    'request-hash-1',
    '[{"blockKey":"deploy","blockType":"command","title":"Deploy","language":"bash","content":"docker compose up -d","position":0,"copyable":true,"contentHash":"block-hash"}]'::jsonb,
    '[{"sourceType":"note_chunk","sourceKey":"section-0","sourceTitle":"Transaction Note","headingPath":"Transaction Note","content":"body","contentHash":"document-hash","position":0}]'::jsonb
  )->>'status'),
  'ok',
  'create returns ok'
);
select is((select version from notesdb.notes where id = '33333333-3333-4333-8333-333333333333'), 1::bigint, 'a created note starts at version 1');
select is((select count(*)::integer from notesdb.note_blocks where note_id = '33333333-3333-4333-8333-333333333333'), 1, 'create upserts parsed blocks');
select is((select count(*)::integer from notesdb.search_documents where note_id = '33333333-3333-4333-8333-333333333333'), 1, 'create upserts search documents');

select is(
  (public.qnotes_update_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333333', 'transaction-note', 'Transaction Note Updated', '# Transaction Note Updated\n\nchanged', 'Transaction Note Updated changed', '{}', 1, '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333336', 'request-hash-2', '[]'::jsonb, '[]'::jsonb)->>'status'),
  'ok',
  'matching update returns ok'
);
select is((select version from notesdb.notes where id = '33333333-3333-4333-8333-333333333333'), 2::bigint, 'matching update increments version once');
select is((select count(*)::integer from notesdb.note_blocks where note_id = '33333333-3333-4333-8333-333333333333'), 0, 'removed blocks are deleted');
select is((select count(*)::integer from notesdb.search_documents where note_id = '33333333-3333-4333-8333-333333333333'), 0, 'removed documents are deleted');

select is(
  (public.qnotes_update_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333333', 'transaction-note', 'Transaction Note Updated', '# Transaction Note Updated\n\nchanged', 'Transaction Note Updated changed', '{}', 1, '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333336', 'request-hash-2', '[]'::jsonb, '[]'::jsonb)->>'status'),
  'idempotent',
  'the exact mutation retry is idempotent'
);
select is((select version from notesdb.notes where id = '33333333-3333-4333-8333-333333333333'), 2::bigint, 'idempotent retry does not increment version');
select is(
  (public.qnotes_update_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333333', 'transaction-note', 'Transaction Note Updated', '# Transaction Note Updated\n\nchanged', 'Transaction Note Updated changed', '{}', 1, '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333336', 'different-hash', '[]'::jsonb, '[]'::jsonb)->>'status'),
  'mutation_reuse_conflict',
  'a reused mutation ID with a different hash is rejected'
);
select is(
  (public.qnotes_update_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333333', 'transaction-note', 'Stale', 'stale', 'stale', '{}', 1, '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333337', 'request-hash-3', '[]'::jsonb, '[]'::jsonb)->>'status'),
  'version_conflict',
  'a stale update returns version_conflict'
);
select is((public.qnotes_update_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333333', 'transaction-note', 'Stale', 'stale', 'stale', '{}', 1, '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333338', 'request-hash-4', '[]'::jsonb, '[]'::jsonb)->>'currentVersion'), '2', 'version conflict returns the authoritative version');

select is((public.qnotes_create_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333339', 'transaction-note', 'Duplicate', '', '', '{}', '33333333-3333-4333-8333-333333333340', '33333333-3333-4333-8333-333333333341', 'request-hash-5', '[]'::jsonb, '[]'::jsonb)->>'status'), 'slug_conflict', 'duplicate active slugs are rejected per owner');
select is((public.qnotes_create_note((select id from auth.users where email = 'other@qnotes.local'), '33333333-3333-4333-8333-333333333342', 'transaction-note', 'Other Owner Note', '', '', '{}', '33333333-3333-4333-8333-333333333343', '33333333-3333-4333-8333-333333333344', 'request-hash-6', '[]'::jsonb, '[]'::jsonb)->>'status'), 'ok', 'different owners may use the same slug');

select is((public.qnotes_soft_delete_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333333', 2, '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333345', 'request-hash-7')->>'status'), 'ok', 'soft delete returns ok');
select ok((select deleted_at is not null from notesdb.notes where id = '33333333-3333-4333-8333-333333333333'), 'soft delete sets deleted_at');
select is((public.qnotes_restore_note((select id from auth.users where email = 'owner@qnotes.local'), '33333333-3333-4333-8333-333333333333', 3, '33333333-3333-4333-8333-333333333334', '33333333-3333-4333-8333-333333333346', 'request-hash-8')->>'status'), 'ok', 'restore returns ok');
select is((select version from notesdb.notes where id = '33333333-3333-4333-8333-333333333333'), 4::bigint, 'restore increments version once');
select ok((select deleted_at is null from notesdb.notes where id = '33333333-3333-4333-8333-333333333333'), 'restore clears deleted_at');

select * from finish();
rollback;
