alter table notesdb.notes enable row level security;
alter table notesdb.note_blocks enable row level security;
alter table notesdb.search_documents enable row level security;
alter table notesdb.attachments enable row level security;
alter table notesdb.note_mutations enable row level security;

revoke all on schema notesdb from public, anon, authenticated;
grant usage on schema notesdb to authenticated, service_role;

revoke all on table notesdb.notes, notesdb.note_blocks, notesdb.search_documents, notesdb.attachments, notesdb.note_mutations from anon, authenticated;
grant select on table notesdb.notes, notesdb.note_blocks, notesdb.search_documents, notesdb.attachments to authenticated;
grant all on table notesdb.notes, notesdb.note_blocks, notesdb.search_documents, notesdb.attachments, notesdb.note_mutations to service_role;

create policy notes_owner_select on notesdb.notes
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));
create policy note_blocks_owner_select on notesdb.note_blocks
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));
create policy search_documents_owner_select on notesdb.search_documents
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));
create policy attachments_owner_select on notesdb.attachments
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit)
values ('note-attachments', 'note-attachments', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

create policy note_attachments_select on storage.objects
for select to authenticated
using (bucket_id = 'note-attachments' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy note_attachments_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'note-attachments' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy note_attachments_update on storage.objects
for update to authenticated
using (bucket_id = 'note-attachments' and split_part(name, '/', 1) = (select auth.uid())::text)
with check (bucket_id = 'note-attachments' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy note_attachments_delete on storage.objects
for delete to authenticated
using (bucket_id = 'note-attachments' and split_part(name, '/', 1) = (select auth.uid())::text);

create policy realtime_user_notes_read on realtime.messages
for select to authenticated
using (extension = 'broadcast' and realtime.topic() = 'user:' || (select auth.uid())::text || ':notes');
