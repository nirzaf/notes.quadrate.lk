-- US-09: personal tokens can be explicitly account-wide or notebook-scoped.
-- The API remains the only caller of these service-role functions.

alter table notesdb.api_tokens
  add column if not exists access_mode text,
  add column if not exists allow_unfiled boolean,
  add column if not exists policy_revision bigint;

-- Existing tokens were account-wide. Record that fact before enforcing the
-- new representation so an empty grant set never silently means deny-all.
update notesdb.api_tokens
set access_mode = 'account',
    allow_unfiled = true,
    policy_revision = 1
where access_mode is null
   or allow_unfiled is null
   or policy_revision is null;

alter table notesdb.api_tokens
  alter column access_mode set default 'account',
  alter column access_mode set not null,
  alter column allow_unfiled set default false,
  alter column allow_unfiled set not null,
  alter column policy_revision set default 1,
  alter column policy_revision set not null;

alter table notesdb.api_tokens
  drop constraint if exists api_tokens_access_mode_check;
alter table notesdb.api_tokens
  add constraint api_tokens_access_mode_check check (access_mode in ('account', 'notebooks'));
alter table notesdb.api_tokens
  drop constraint if exists api_tokens_policy_revision_check;
alter table notesdb.api_tokens
  add constraint api_tokens_policy_revision_check check (policy_revision > 0);
alter table notesdb.api_tokens
  drop constraint if exists api_tokens_access_consistency_check;
alter table notesdb.api_tokens
  add constraint api_tokens_access_consistency_check check (access_mode <> 'account' or allow_unfiled);

create table if not exists notesdb.api_token_notebook_grants (
  token_id uuid not null references notesdb.api_tokens(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  notebook_id uuid not null references notesdb.notebooks(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (token_id, notebook_id)
);
create index if not exists api_token_notebook_grants_owner_token_key
  on notesdb.api_token_notebook_grants (owner_id, token_id, notebook_id);
alter table notesdb.api_token_notebook_grants enable row level security;
revoke all on table notesdb.api_token_notebook_grants from anon, authenticated;
grant all on table notesdb.api_token_notebook_grants to service_role;

create or replace function public.qnotes_bump_api_token_policy_revision()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    update notesdb.api_tokens
    set policy_revision = policy_revision + 1
    where id = old.token_id;
    return old;
  end if;

  update notesdb.api_tokens
  set policy_revision = policy_revision + 1
  where id = new.token_id;
  return new;
end;
$$;

drop trigger if exists api_token_notebook_grants_policy_revision on notesdb.api_token_notebook_grants;
create trigger api_token_notebook_grants_policy_revision
after insert or update or delete on notesdb.api_token_notebook_grants
for each row execute function public.qnotes_bump_api_token_policy_revision();

create or replace function public.qnotes_api_token_access(p_token_id uuid, p_owner_id uuid)
returns table (
  access_mode text,
  allow_unfiled boolean,
  policy_revision bigint,
  notebook_ids uuid[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select t.access_mode,
    case when t.access_mode = 'account' then true else t.allow_unfiled end,
    t.policy_revision,
    coalesce(array_agg(g.notebook_id order by g.notebook_id) filter (where g.notebook_id is not null), '{}'::uuid[])
  from notesdb.api_tokens t
  left join notesdb.api_token_notebook_grants g
    on g.token_id = t.id and g.owner_id = t.owner_id
  where t.id = p_token_id and t.owner_id = p_owner_id
  group by t.access_mode, t.allow_unfiled, t.policy_revision;
$$;

create or replace function public.qnotes_create_api_token(
  p_owner_id uuid,
  p_name text,
  p_token_prefix text,
  p_token_hash text,
  p_scopes text[],
  p_expires_at timestamptz,
  p_access_mode text,
  p_allow_unfiled boolean,
  p_notebook_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  token_row notesdb.api_tokens%rowtype;
  notebook_ids uuid[] := coalesce(p_notebook_ids, '{}'::uuid[]);
begin
  if p_access_mode not in ('account', 'notebooks') then
    raise exception 'invalid_access_mode' using errcode = 'P0001';
  end if;
  if p_access_mode = 'account' and (cardinality(notebook_ids) > 0 or p_allow_unfiled is distinct from true) then
    raise exception 'invalid_account_access' using errcode = 'P0001';
  end if;
  if p_access_mode = 'notebooks' and p_allow_unfiled is null then
    raise exception 'invalid_unfiled_access' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from unnest(notebook_ids) as requested(notebook_id)
    where not exists (
      select 1 from notesdb.notebooks n
      where n.id = requested.notebook_id and n.owner_id = p_owner_id
    )
  ) then
    raise exception 'notebook_not_found' using errcode = 'P0001';
  end if;

  insert into notesdb.api_tokens (
    owner_id, name, token_prefix, token_hash, scopes, expires_at,
    access_mode, allow_unfiled, policy_revision
  ) values (
    p_owner_id, p_name, p_token_prefix, p_token_hash, p_scopes, p_expires_at,
    p_access_mode, case when p_access_mode = 'account' then true else p_allow_unfiled end, 1
  ) returning * into token_row;

  if p_access_mode = 'notebooks' and cardinality(notebook_ids) > 0 then
    insert into notesdb.api_token_notebook_grants (token_id, owner_id, notebook_id)
    select token_row.id, p_owner_id, requested.notebook_id
    from (select distinct unnest(notebook_ids) as notebook_id) as requested;
  end if;

  return jsonb_build_object(
    'id', token_row.id,
    'name', token_row.name,
    'token_prefix', token_row.token_prefix,
    'scopes', token_row.scopes,
    'access', jsonb_build_object(
      'mode', token_row.access_mode,
      'notebookIds', case when token_row.access_mode = 'account' then '[]'::jsonb else to_jsonb(notebook_ids) end,
      'allowUnfiled', case when token_row.access_mode = 'account' then true else token_row.allow_unfiled end
    ),
    'expires_at', token_row.expires_at,
    'last_used_at', token_row.last_used_at,
    'revoked_at', token_row.revoked_at,
    'created_at', token_row.created_at
  );
end;
$$;

-- Notebook-scoped search calls the existing ranked functions once per granted
-- notebook and once for unfiled notes, then applies the global cap and page.
-- ponytail: bounded 1,000-candidate fanout; raise only after measured search
-- pages need more than the existing service-role candidate ceiling.
create or replace function public.qnotes_keyword_search_scoped(
  p_owner_id uuid,
  p_query text,
  p_limit integer,
  p_filters jsonb,
  p_offset integer,
  p_max_per_note integer,
  p_notebook_ids uuid[],
  p_allow_unfiled boolean
) returns table (
  id uuid, note_id uuid, note_slug text, note_title text, source_type text,
  source_id uuid, source_key text, source_title text, heading_path text,
  snippet text, score double precision, keyword_rank integer,
  semantic_rank integer, block_key text, language text, attachment_id uuid
)
language sql
security definer
set search_path = public, extensions
as $$
  with scopes as (
    select notebook_id, false as unfiled from unnest(coalesce(p_notebook_ids, '{}'::uuid[])) as requested(notebook_id)
    union all
    select null::uuid, true where coalesce(p_allow_unfiled, false)
  ), candidates as (
    select result.*
    from scopes s
    cross join lateral public.qnotes_keyword_search(
      p_owner_id, p_query, 1000,
      coalesce(p_filters, '{}'::jsonb) || jsonb_build_object(
        'notebookIds', case when s.unfiled then '[]'::jsonb else jsonb_build_array(s.notebook_id) end,
        'unfiled', s.unfiled
      ),
      0, p_max_per_note
    ) result
  ), unique_candidates as (
    select distinct on (id) *
    from candidates
    order by id, score desc, source_key
  ), per_note as (
    select unique_candidates.*,
      row_number() over (partition by note_id order by score desc, id)::integer as note_rank
    from unique_candidates
  )
  select id, note_id, note_slug, note_title, source_type, source_id, source_key,
    source_title, heading_path, snippet, score, keyword_rank, semantic_rank,
    block_key, language, attachment_id
  from per_note
  where note_rank <= greatest(1, least(coalesce(p_max_per_note, 2), 10))
  order by score desc, id
  limit greatest(1, least(coalesce(p_limit, 21), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function public.qnotes_semantic_search_scoped(
  p_owner_id uuid,
  p_query text,
  p_embedding extensions.vector(384),
  p_limit integer,
  p_filters jsonb,
  p_offset integer,
  p_max_per_note integer,
  p_notebook_ids uuid[],
  p_allow_unfiled boolean
) returns table (
  id uuid, note_id uuid, note_slug text, note_title text, source_type text,
  source_id uuid, source_key text, source_title text, heading_path text,
  snippet text, score double precision, keyword_rank integer,
  semantic_rank integer, block_key text, language text, attachment_id uuid
)
language sql
security definer
set search_path = public, extensions
as $$
  with scopes as (
    select notebook_id, false as unfiled from unnest(coalesce(p_notebook_ids, '{}'::uuid[])) as requested(notebook_id)
    union all
    select null::uuid, true where coalesce(p_allow_unfiled, false)
  ), candidates as (
    select result.*
    from scopes s
    cross join lateral public.qnotes_semantic_search(
      p_owner_id, p_query, p_embedding, 1000,
      coalesce(p_filters, '{}'::jsonb) || jsonb_build_object(
        'notebookIds', case when s.unfiled then '[]'::jsonb else jsonb_build_array(s.notebook_id) end,
        'unfiled', s.unfiled
      ),
      0, p_max_per_note
    ) result
  ), unique_candidates as (
    select distinct on (id) *
    from candidates
    order by id, score desc, source_key
  ), per_note as (
    select unique_candidates.*,
      row_number() over (partition by note_id order by score desc, id)::integer as note_rank
    from unique_candidates
  )
  select id, note_id, note_slug, note_title, source_type, source_id, source_key,
    source_title, heading_path, snippet, score, keyword_rank, semantic_rank,
    block_key, language, attachment_id
  from per_note
  where note_rank <= greatest(1, least(coalesce(p_max_per_note, 2), 10))
  order by score desc, id
  limit greatest(1, least(coalesce(p_limit, 21), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function public.qnotes_hybrid_search_scoped(
  p_owner_id uuid,
  p_query text,
  p_embedding extensions.vector(384),
  p_limit integer,
  p_rrf_k integer,
  p_filters jsonb,
  p_offset integer,
  p_max_per_note integer,
  p_notebook_ids uuid[],
  p_allow_unfiled boolean
) returns table (
  id uuid, note_id uuid, note_slug text, note_title text, source_type text,
  source_id uuid, source_key text, source_title text, heading_path text,
  snippet text, score double precision, keyword_rank integer,
  semantic_rank integer, block_key text, language text, attachment_id uuid
)
language sql
security definer
set search_path = public, extensions
as $$
  with scopes as (
    select notebook_id, false as unfiled from unnest(coalesce(p_notebook_ids, '{}'::uuid[])) as requested(notebook_id)
    union all
    select null::uuid, true where coalesce(p_allow_unfiled, false)
  ), candidates as (
    select result.*
    from scopes s
    cross join lateral public.qnotes_hybrid_search(
      p_owner_id, p_query, p_embedding, 1000, p_rrf_k,
      coalesce(p_filters, '{}'::jsonb) || jsonb_build_object(
        'notebookIds', case when s.unfiled then '[]'::jsonb else jsonb_build_array(s.notebook_id) end,
        'unfiled', s.unfiled
      ),
      0, p_max_per_note
    ) result
  ), unique_candidates as (
    select distinct on (id) *
    from candidates
    order by id, score desc, source_key
  ), per_note as (
    select unique_candidates.*,
      row_number() over (partition by note_id order by score desc, id)::integer as note_rank
    from unique_candidates
  )
  select id, note_id, note_slug, note_title, source_type, source_id, source_key,
    source_title, heading_path, snippet, score, keyword_rank, semantic_rank,
    block_key, language, attachment_id
  from per_note
  where note_rank <= greatest(1, least(coalesce(p_max_per_note, 2), 10))
  order by score desc, id
  limit greatest(1, least(coalesce(p_limit, 21), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function public.qnotes_search_freshness_scoped(
  p_owner_id uuid,
  p_notebook_ids uuid[],
  p_allow_unfiled boolean
) returns table (pending_documents integer, failed_documents integer, oldest_queued_at timestamptz)
language sql
security definer
set search_path = public, extensions
as $$
  with queued as (
    select d.embedding_status, d.embedding_queued_at
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    where d.owner_id = p_owner_id
      and (n.notebook_id = any(coalesce(p_notebook_ids, '{}'::uuid[]))
        or (coalesce(p_allow_unfiled, false) and n.notebook_id is null))
      and d.embedding_status in ('pending', 'failed')
  )
  select count(*) filter (where embedding_status = 'pending')::integer,
    count(*) filter (where embedding_status = 'failed')::integer,
    min(embedding_queued_at) filter (where embedding_status = 'pending')
  from queued;
$$;

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'qnotes_api_token_access(uuid,uuid)',
    'qnotes_create_api_token(uuid,text,text,text,text[],timestamptz,text,boolean,uuid[])',
    'qnotes_keyword_search_scoped(uuid,text,integer,jsonb,integer,integer,uuid[],boolean)',
    'qnotes_semantic_search_scoped(uuid,text,extensions.vector,integer,jsonb,integer,integer,uuid[],boolean)',
    'qnotes_hybrid_search_scoped(uuid,text,extensions.vector,integer,integer,jsonb,integer,integer,uuid[],boolean)',
    'qnotes_search_freshness_scoped(uuid,uuid[],boolean)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', signature);
    execute format('grant execute on function public.%s to service_role', signature);
  end loop;
end;
$$;
