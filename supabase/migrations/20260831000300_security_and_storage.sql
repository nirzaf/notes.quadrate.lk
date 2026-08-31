alter table public.notes enable row level security;
alter table public.note_blocks enable row level security;
alter table public.search_documents enable row level security;
alter table public.attachments enable row level security;
alter table public.note_mutations enable row level security;

revoke all on table public.notes, public.note_blocks, public.search_documents, public.attachments, public.note_mutations from anon, authenticated;
grant select on table public.notes, public.note_blocks, public.search_documents, public.attachments to authenticated;

create policy notes_owner_select on public.notes
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));
create policy note_blocks_owner_select on public.note_blocks
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));
create policy search_documents_owner_select on public.search_documents
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));
create policy attachments_owner_select on public.attachments
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
