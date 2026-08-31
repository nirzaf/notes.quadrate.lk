create or replace function public.qnotes_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table notesdb.notes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  title text not null,
  content_markdown text not null default '',
  content_plain text not null default '',
  tags text[] not null default '{}',
  version bigint not null default 1,
  last_mutation_id uuid not null,
  updated_by_device_id uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz null,
  constraint notes_version_positive check (version > 0)
);

create unique index notes_active_owner_slug_key
  on notesdb.notes (owner_id, lower(slug))
  where deleted_at is null;
create index notes_owner_updated_key on notesdb.notes (owner_id, updated_at desc, id desc);
create index notes_owner_deleted_key on notesdb.notes (owner_id, deleted_at);
create index notes_tags_gin_key on notesdb.notes using gin (tags);

create table notesdb.note_blocks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references notesdb.notes(id) on delete cascade,
  block_key text not null,
  block_type text not null,
  title text null,
  language text null,
  content text not null,
  position integer not null,
  copyable boolean not null default true,
  content_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint note_blocks_note_key_unique unique (note_id, block_key),
  constraint note_blocks_type_check check (block_type in ('copy', 'code', 'prompt', 'command', 'sql', 'json', 'yaml', 'env', 'url', 'quote', 'checklist')),
  constraint note_blocks_position_check check (position >= 0)
);
create index note_blocks_owner_note_position_key on notesdb.note_blocks (owner_id, note_id, position);

create table notesdb.search_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references notesdb.notes(id) on delete cascade,
  source_type text not null,
  source_id uuid null,
  source_key text not null,
  source_title text not null,
  heading_path text null,
  content text not null,
  content_hash text not null,
  position integer not null,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(source_title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(heading_path, '')), 'B')
    || setweight(to_tsvector('simple', coalesce(content, '')), 'C')
  ) stored,
  embedding extensions.vector(384) null,
  embedding_status text not null default 'pending',
  embedding_error text null,
  embedding_model text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint search_documents_note_source_unique unique (note_id, source_type, source_key),
  constraint search_documents_source_type_check check (source_type in ('note_chunk', 'copy_block', 'code_block', 'attachment_chunk')),
  constraint search_documents_embedding_status_check check (embedding_status in ('pending', 'ready', 'failed')),
  constraint search_documents_position_check check (position >= 0)
);
create index search_documents_vector_gin_key on notesdb.search_documents using gin (search_vector);
create index search_documents_embedding_hnsw_key on notesdb.search_documents using hnsw (embedding extensions.vector_ip_ops);
create index search_documents_owner_note_key on notesdb.search_documents (owner_id, note_id);
create index search_documents_owner_embedding_status_key on notesdb.search_documents (owner_id, embedding_status);

create table notesdb.attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references notesdb.notes(id) on delete cascade,
  bucket text not null default 'note-attachments',
  object_path text not null unique,
  original_file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  checksum_sha256 text null,
  extraction_status text not null default 'pending_upload',
  extraction_error text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz null,
  constraint attachments_size_check check (size_bytes >= 0),
  constraint attachments_status_check check (extraction_status in ('pending_upload', 'uploaded', 'queued', 'processing', 'ready', 'failed', 'unsupported', 'deleted'))
);
create index attachments_owner_note_created_key on notesdb.attachments (owner_id, note_id, created_at);
create index attachments_owner_status_key on notesdb.attachments (owner_id, extraction_status);

create table notesdb.note_mutations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  operation text not null,
  request_hash text not null,
  note_id uuid not null,
  resulting_version bigint not null,
  response jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (owner_id, mutation_id)
);
create index note_mutations_created_key on notesdb.note_mutations (created_at);

create trigger notes_set_updated_at before update on notesdb.notes
for each row execute function public.qnotes_set_updated_at();
create trigger note_blocks_set_updated_at before update on notesdb.note_blocks
for each row execute function public.qnotes_set_updated_at();
create trigger search_documents_set_updated_at before update on notesdb.search_documents
for each row execute function public.qnotes_set_updated_at();
create trigger attachments_set_updated_at before update on notesdb.attachments
for each row execute function public.qnotes_set_updated_at();
