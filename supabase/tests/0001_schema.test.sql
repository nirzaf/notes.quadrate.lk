begin;
select plan(33);

select ok(to_regnamespace('notesdb') is not null, 'notesdb schema exists');

select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'notes'),
  array['id','owner_id','slug','title','content_markdown','content_plain','tags','version','last_mutation_id','updated_by_device_id','created_at','updated_at','deleted_at','notebook_id']::text[],
  'notes has the required columns'
);
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'note_blocks'),
  array['id','owner_id','note_id','block_key','block_type','title','language','content','position','copyable','content_hash','created_at','updated_at']::text[],
  'note_blocks has the required columns'
);
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'search_documents'),
  array['id','owner_id','note_id','source_type','source_id','source_key','source_title','heading_path','content','content_hash','position','search_vector','embedding','embedding_status','embedding_error','embedding_model','created_at','updated_at']::text[],
  'search_documents has the required columns'
);
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'attachments'),
  array['id','owner_id','note_id','bucket','object_path','original_file_name','mime_type','size_bytes','checksum_sha256','extraction_status','extraction_error','created_at','updated_at','deleted_at']::text[],
  'attachments has the required columns'
);
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'note_mutations'),
  array['owner_id','mutation_id','operation','request_hash','note_id','resulting_version','response','created_at']::text[],
  'note_mutations has the required columns'
);
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'api_tokens'),
  array['id','owner_id','name','token_prefix','token_hash','scopes','expires_at','last_used_at','revoked_at','created_at']::text[],
  'api_tokens has the required columns'
);

select ok((select count(*) = 6 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where (e.extname, n.nspname) in (('pgcrypto','extensions'),('vector','extensions'),('pgmq','pgmq'),('pg_net','extensions'),('pg_cron','pg_catalog'),('supabase_vault','vault'))), 'required extensions are installed in their expected schemas');

select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'notes'), 'RLS is enabled on notesdb.notes');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'note_blocks'), 'RLS is enabled on notesdb.note_blocks');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'search_documents'), 'RLS is enabled on notesdb.search_documents');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'attachments'), 'RLS is enabled on notesdb.attachments');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'note_mutations'), 'RLS is enabled on notesdb.note_mutations');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'api_tokens'), 'RLS is enabled on notesdb.api_tokens');

select ok(not has_table_privilege('anon', 'notesdb.notes', 'SELECT'), 'anon cannot select notes');
select ok(not has_table_privilege('anon', 'notesdb.note_blocks', 'SELECT'), 'anon cannot select note_blocks');
select ok(not has_table_privilege('anon', 'notesdb.search_documents', 'SELECT'), 'anon cannot select search_documents');
select ok(not has_table_privilege('anon', 'notesdb.attachments', 'SELECT'), 'anon cannot select attachments');
select ok(not has_table_privilege('anon', 'notesdb.note_mutations', 'SELECT'), 'anon cannot select note_mutations');
select ok(not has_table_privilege('anon', 'notesdb.api_tokens', 'SELECT'), 'anon cannot select api_tokens');

select ok(has_table_privilege('authenticated', 'notesdb.notes', 'SELECT'), 'authenticated can select notes');
select ok(has_table_privilege('authenticated', 'notesdb.note_blocks', 'SELECT'), 'authenticated can select note_blocks');
select ok(has_table_privilege('authenticated', 'notesdb.search_documents', 'SELECT'), 'authenticated can select search_documents');
select ok(has_table_privilege('authenticated', 'notesdb.attachments', 'SELECT'), 'authenticated can select attachments');
select ok((select bool_and(not has_table_privilege('authenticated', format('notesdb.%s', table_name), privilege_type)) from (values ('notes','INSERT'),('notes','UPDATE'),('notes','DELETE'),('note_blocks','INSERT'),('note_blocks','UPDATE'),('note_blocks','DELETE'),('search_documents','INSERT'),('search_documents','UPDATE'),('search_documents','DELETE'),('attachments','INSERT'),('attachments','UPDATE'),('attachments','DELETE'),('note_mutations','INSERT'),('note_mutations','UPDATE'),('note_mutations','DELETE'),('api_tokens','INSERT'),('api_tokens','UPDATE'),('api_tokens','DELETE')) as privileges(table_name, privilege_type)), 'authenticated has no direct write privileges');

select ok((select indisunique and indpred is not null from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'notes_active_owner_slug_key'), 'active owner slug is a partial unique index');
select ok(to_regclass('notesdb.notes_owner_updated_key') is not null, 'notes has the owner updated index');
select ok(to_regclass('notesdb.notes_owner_deleted_key') is not null, 'notes has the owner deleted index');
select ok((select am.amname = 'gin' from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_index i on i.indexrelid = c.oid join pg_am am on am.oid = c.relam where n.nspname = 'notesdb' and c.relname = 'notes_tags_gin_key'), 'notes tags use a GIN index');
select ok((select am.amname = 'gin' from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_index i on i.indexrelid = c.oid join pg_am am on am.oid = c.relam where n.nspname = 'notesdb' and c.relname = 'search_documents_vector_gin_key'), 'search vectors use a GIN index');
select ok((select am.amname = 'hnsw' from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_index i on i.indexrelid = c.oid join pg_am am on am.oid = c.relam where n.nspname = 'notesdb' and c.relname = 'search_documents_embedding_hnsw_key'), 'embeddings use an HNSW index');
select ok((select count(*) = 2 from pgmq.list_queues() where queue_name in ('note-embeddings', 'attachment-processing')), 'both worker queues exist');
select ok((select count(*) = 2 from cron.job where jobname in ('qnotes-process-embeddings', 'qnotes-process-attachments')), 'both worker cron jobs exist');

select * from finish();
rollback;
