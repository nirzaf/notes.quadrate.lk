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
  -- The deployed pre-US-09 writer omits these columns; its account-wide
  -- insert must satisfy the consistency check during the rollout window.
  alter column access_mode set default 'account',
  alter column access_mode set not null,
  alter column allow_unfiled set default true,
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

-- Notebook-scoped search applies the authorization predicate before ranking so
-- rank values are comparable across the authorized notebooks and unfiled notes.
-- ponytail: one global ranked query per retrieval mode; raise the 1,000-row
-- candidate ceiling only after measured search pages need more.
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
  with params as (
    select
      lower(btrim(coalesce(p_query, ''))) as normalized_query,
      websearch_to_tsquery('simple', coalesce(p_query, '')) as ts_query,
      greatest(1, least(coalesce(p_limit, 21), 1000)) as result_limit,
      greatest(0, coalesce(p_offset, 0)) as result_offset,
      greatest(1, least(coalesce(p_max_per_note, 2), 10)) as note_limit,
      coalesce(p_notebook_ids, '{}'::uuid[]) as notebook_ids,
      coalesce(p_allow_unfiled, false) as allow_unfiled
  ),
  filter_values as (
    select
      coalesce((select array_agg(item) from jsonb_array_elements_text(coalesce(p_filters->'tags', '[]'::jsonb)) as items(item)), '{}'::text[]) as tags,
      coalesce((select array_agg(item) from jsonb_array_elements_text(coalesce(p_filters->'sourceTypes', '[]'::jsonb)) as items(item)), '{}'::text[]) as source_types,
      coalesce((select array_agg(lower(item)) from jsonb_array_elements_text(coalesce(p_filters->'languages', '[]'::jsonb)) as items(item)), '{}'::text[]) as languages,
      nullif(p_filters->>'updatedAfter', '')::timestamptz as updated_after
  ),
  base as not materialized (
    select
      d.id, d.note_id, n.slug as note_slug, n.title as note_title, d.source_type,
      coalesce(b.id, d.source_id) as source_id, d.source_key, d.source_title,
      d.heading_path, d.content, d.search_vector, b.block_key, b.language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as attachment_id,
      case d.source_type when 'code_block' then 0 when 'copy_block' then 1 when 'note_metadata' then 2 when 'note_chunk' then 3 else 4 end as source_priority
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
    cross join params p
    cross join filter_values f
    where d.owner_id = p_owner_id
      and (d.embedding is null or d.embedding_mode = coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider'))
      and (n.notebook_id = any(p.notebook_ids) or (p.allow_unfiled and n.notebook_id is null))
      and (cardinality(f.tags) = 0 or n.tags @> f.tags)
      and (cardinality(f.source_types) = 0 or d.source_type = any(f.source_types))
      and (cardinality(f.languages) = 0 or lower(coalesce(b.language, '')) = any(f.languages))
      and (f.updated_after is null or n.updated_at > f.updated_after)
  ),
  exact_candidates as (
    select b.id, row_number() over (order by b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where (b.source_type = 'note_metadata' and lower(b.note_slug) = p.normalized_query)
       or lower(b.source_key) = p.normalized_query
       or lower(coalesce(b.block_key, '')) = p.normalized_query
  ),
  title_candidates as (
    select b.id, row_number() over (order by b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where (b.source_type = 'note_metadata' and lower(b.note_title) = p.normalized_query)
       or (b.source_type in ('copy_block', 'code_block', 'attachment_chunk') and lower(b.source_title) = p.normalized_query)
  ),
  fts_candidates as (
    select b.id, row_number() over (order by ts_rank_cd(b.search_vector, p.ts_query) desc, b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p where b.search_vector @@ p.ts_query
  ),
  trigram_candidates as (
    select b.id, row_number() over (order by greatest(similarity(lower(b.source_title), p.normalized_query), similarity(lower(b.source_key), p.normalized_query), similarity(lower(b.content), p.normalized_query)) desc, b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where lower(b.source_title) % p.normalized_query or lower(b.source_key) % p.normalized_query
       or lower(b.content) % p.normalized_query or position(p.normalized_query in lower(b.content)) > 0
  ),
  keyword_scores as (
    select id, sum(weight / (60.0 + channel_rank))::double precision as score
    from (
      select id, channel_rank, 2.0::double precision as weight from exact_candidates
      union all select id, channel_rank, 1.5::double precision from title_candidates
      union all select id, channel_rank, 1.2::double precision from fts_candidates
      union all select id, channel_rank, 0.8::double precision from trigram_candidates
    ) channels group by id
  ),
  ranked as (
    select b.*, k.score, row_number() over (order by k.score desc, b.source_priority, b.id)::integer as keyword_rank
    from keyword_scores k join base b on b.id = k.id
  ),
  per_note as (
    select ranked.*, row_number() over (partition by note_id order by score desc, source_priority, id)::integer as note_rank
    from ranked
  )
  select id, note_id, note_slug, note_title, source_type, source_id, source_key,
    source_title, heading_path, public.qnotes_search_snippet(content, p_query),
    score, keyword_rank, null::integer, block_key, language, attachment_id
  from per_note cross join params p
  where note_rank <= p.note_limit
  order by score desc, source_priority, id
  limit (select result_limit from params) offset (select result_offset from params);
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
  with params as (
    select greatest(1, least(coalesce(p_limit, 21), 1000)) as result_limit,
      greatest(0, coalesce(p_offset, 0)) as result_offset,
      greatest(1, least(coalesce(p_max_per_note, 2), 10)) as note_limit,
      greatest(50, least((greatest(0, coalesce(p_offset, 0)) + greatest(1, least(coalesce(p_limit, 21), 1000))) * 5, 1000)) as candidate_limit,
      coalesce(p_notebook_ids, '{}'::uuid[]) as notebook_ids,
      coalesce(p_allow_unfiled, false) as allow_unfiled
  ),
  filter_values as (
    select
      coalesce((select array_agg(item) from jsonb_array_elements_text(coalesce(p_filters->'tags', '[]'::jsonb)) as items(item)), '{}'::text[]) as tags,
      coalesce((select array_agg(item) from jsonb_array_elements_text(coalesce(p_filters->'sourceTypes', '[]'::jsonb)) as items(item)), '{}'::text[]) as source_types,
      coalesce((select array_agg(lower(item)) from jsonb_array_elements_text(coalesce(p_filters->'languages', '[]'::jsonb)) as items(item)), '{}'::text[]) as languages,
      nullif(p_filters->>'updatedAfter', '')::timestamptz as updated_after
  ),
  semantic_candidates as materialized (
    select d.id, d.embedding <#> p_embedding as distance
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
    cross join params p
    cross join filter_values f
    where d.owner_id = p_owner_id and d.embedding_status = 'ready' and d.embedding is not null
      and d.embedding_model = 'gte-small' and d.embedding_model_version = 'v2'
      and d.embedding_mode = coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider')
      and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
      and (n.notebook_id = any(p.notebook_ids) or (p.allow_unfiled and n.notebook_id is null))
      and (cardinality(f.tags) = 0 or n.tags @> f.tags)
      and (cardinality(f.source_types) = 0 or d.source_type = any(f.source_types))
      and (cardinality(f.languages) = 0 or lower(coalesce(b.language, '')) = any(f.languages))
      and (f.updated_after is null or n.updated_at > f.updated_after)
    order by d.embedding <#> p_embedding
    limit (select candidate_limit from params)
  ),
  ranked as (
    select d.id, d.note_id, n.slug as note_slug, n.title as note_title, d.source_type,
      coalesce(b.id, d.source_id) as source_id, d.source_key, d.source_title, d.heading_path,
      d.content, -sc.distance as score, row_number() over (order by sc.distance, d.id)::integer as semantic_rank,
      b.block_key, b.language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as attachment_id,
      case d.source_type when 'code_block' then 0 when 'copy_block' then 1 when 'note_metadata' then 2 when 'note_chunk' then 3 else 4 end as source_priority
    from semantic_candidates sc
    join notesdb.search_documents d on d.id = sc.id
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
  ),
  per_note as (
    select ranked.*, row_number() over (partition by note_id order by score desc, source_priority, id)::integer as note_rank
    from ranked
  )
  select id, note_id, note_slug, note_title, source_type, source_id, source_key,
    source_title, heading_path, public.qnotes_search_snippet(content, p_query),
    score, null::integer, semantic_rank, block_key, language, attachment_id
  from per_note cross join params p
  where note_rank <= p.note_limit
  order by score desc, source_priority, id
  limit (select result_limit from params) offset (select result_offset from params);
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
  with params as (
    select greatest(1, least(coalesce(p_limit, 21), 1000)) as result_limit,
      greatest(0, coalesce(p_offset, 0)) as result_offset,
      greatest(1, least(coalesce(p_max_per_note, 2), 10)) as note_limit,
      1000 as candidate_limit
  ),
  keyword as (
    select k.*
    from public.qnotes_keyword_search_scoped(
      p_owner_id, p_query, (select candidate_limit from params), p_filters, 0,
      (select note_limit from params), p_notebook_ids, p_allow_unfiled
    ) k
  ),
  semantic as (
    select s.*
    from public.qnotes_semantic_search_scoped(
      p_owner_id, p_query, p_embedding, (select candidate_limit from params), p_filters, 0,
      (select note_limit from params), p_notebook_ids, p_allow_unfiled
    ) s
  ),
  combined as (
    select coalesce(k.id, s.id) as result_id,
      coalesce(k.note_id, s.note_id) as result_note_id,
      coalesce(k.note_slug, s.note_slug) as result_note_slug,
      coalesce(k.note_title, s.note_title) as result_note_title,
      coalesce(k.source_type, s.source_type) as result_source_type,
      coalesce(k.source_id, s.source_id) as result_source_id,
      coalesce(k.source_key, s.source_key) as result_source_key,
      coalesce(k.source_title, s.source_title) as result_source_title,
      coalesce(k.heading_path, s.heading_path) as result_heading_path,
      coalesce(k.snippet, s.snippet) as result_snippet,
      (coalesce(k.score, 0) + coalesce(1.0 / (greatest(1, coalesce(p_rrf_k, 60)) + s.semantic_rank), 0))::double precision as result_score,
      k.keyword_rank as result_keyword_rank, s.semantic_rank as result_semantic_rank,
      coalesce(k.block_key, s.block_key) as result_block_key,
      coalesce(k.language, s.language) as result_language,
      coalesce(k.attachment_id, s.attachment_id) as result_attachment_id,
      case coalesce(k.source_type, s.source_type) when 'code_block' then 0 when 'copy_block' then 1 when 'note_metadata' then 2 when 'note_chunk' then 3 else 4 end as source_priority
    from keyword k full join semantic s on s.id = k.id
  ),
  per_note as (
    select combined.*, row_number() over (partition by result_note_id order by result_score desc, source_priority, result_id)::integer as note_rank
    from combined
  )
  select result_id, result_note_id, result_note_slug, result_note_title,
    result_source_type, result_source_id, result_source_key, result_source_title,
    result_heading_path, result_snippet, result_score, result_keyword_rank,
    result_semantic_rank, result_block_key, result_language, result_attachment_id
  from per_note cross join params p
  where note_rank <= p.note_limit
  order by result_score desc, source_priority, result_id
  limit (select result_limit from params) offset (select result_offset from params);
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
