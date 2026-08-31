create table notesdb.notebooks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint notebooks_name_not_blank check (length(btrim(name)) > 0),
  constraint notebooks_name_length check (char_length(name) <= 80)
);

create unique index notebooks_owner_name_key on notesdb.notebooks (owner_id, lower(name));
create index notebooks_owner_created_key on notesdb.notebooks (owner_id, created_at, id);

alter table notesdb.notes
  add column notebook_id uuid null references notesdb.notebooks(id) on delete set null;

create index notes_owner_notebook_updated_key on notesdb.notes (owner_id, notebook_id, updated_at desc, id desc);

create trigger notebooks_set_updated_at before update on notesdb.notebooks
for each row execute function public.qnotes_set_updated_at();

alter table notesdb.notebooks enable row level security;
revoke all on table notesdb.notebooks from anon, authenticated;
grant select on table notesdb.notebooks to authenticated;
grant all on table notesdb.notebooks to service_role;

create policy notebooks_owner_select on notesdb.notebooks
for select to authenticated
using ((select auth.uid()) is not null and owner_id = (select auth.uid()));

create or replace function public.qnotes_note_json(p_note notesdb.notes)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_note.id,
    'slug', p_note.slug,
    'title', p_note.title,
    'contentMarkdown', p_note.content_markdown,
    'contentPlain', p_note.content_plain,
    'tags', p_note.tags,
    'notebookId', p_note.notebook_id,
    'version', p_note.version,
    'createdAt', p_note.created_at,
    'updatedAt', p_note.updated_at,
    'deletedAt', p_note.deleted_at
  );
$$;

create or replace function public.qnotes_move_note_to_notebook(
  p_owner_id uuid,
  p_note_id uuid,
  p_notebook_id uuid,
  p_expected_version bigint,
  p_device_id uuid,
  p_mutation_id uuid,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored notesdb.note_mutations%rowtype;
  note_row notesdb.notes%rowtype;
  response jsonb;
begin
  select * into stored
  from notesdb.note_mutations
  where owner_id = p_owner_id and mutation_id = p_mutation_id
  for update;

  if found then
    if stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks');
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;

  select * into note_row
  from notesdb.notes
  where id = p_note_id and owner_id = p_owner_id
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if note_row.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', note_row.version, 'currentNote', public.qnotes_note_json(note_row));
  end if;
  if p_notebook_id is not null and not exists (
    select 1 from notesdb.notebooks where id = p_notebook_id and owner_id = p_owner_id
  ) then
    return jsonb_build_object('status', 'notebook_not_found');
  end if;

  update notesdb.notes
  set notebook_id = p_notebook_id,
      version = version + 1,
      last_mutation_id = p_mutation_id,
      updated_by_device_id = p_device_id,
      updated_at = timezone('utc', now())
  where id = p_note_id and owner_id = p_owner_id and version = p_expected_version
  returning * into note_row;

  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into notesdb.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'updated', p_request_hash, p_note_id, note_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

revoke all on function public.qnotes_move_note_to_notebook(uuid, uuid, uuid, bigint, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qnotes_move_note_to_notebook(uuid, uuid, uuid, bigint, uuid, uuid, text) to service_role;
