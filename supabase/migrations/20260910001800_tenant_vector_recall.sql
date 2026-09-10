-- US-23: measure filtered vector recall and keep small authorized sets usable.

create or replace function public.qnotes_configure_hnsw_search(p_exact boolean)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  vector_version text;
  version_parts text[];
  supports_iterative boolean := false;
begin
  select extversion
    into vector_version
    from pg_extension
   where extname = 'vector';

  if vector_version is null then
    return 'unsupported';
  end if;

  -- Loading the vector operator makes versioned HNSW GUCs visible in pgvector.
  perform ('[0]'::extensions.vector <#> '[0]'::extensions.vector);
  version_parts := regexp_match(vector_version, '^([0-9]+)\.([0-9]+)');
  supports_iterative := version_parts is not null
    and (
      version_parts[1]::integer > 0
      or (
        version_parts[1]::integer = 0
        and version_parts[2]::integer >= 8
      )
    );

  if p_exact then
    -- Exact scans must retain ordinary B-tree and bitmap paths; the exact
    -- oracle avoids HNSW ordering in its bounded query below.
    perform set_config('enable_seqscan', 'on', true);
    perform set_config('enable_indexscan', 'on', true);
    perform set_config('enable_indexonlyscan', 'on', true);
    perform set_config('enable_bitmapscan', 'on', true);
    return 'exact';
  end if;

  perform set_config('enable_seqscan', 'off', true);
  perform set_config('enable_indexscan', 'on', true);
  perform set_config('enable_indexonlyscan', 'on', true);
  perform set_config('enable_bitmapscan', 'off', true);

  -- ponytail: one measured HNSW budget; raise it only with new local recall data.
  if supports_iterative and current_setting('hnsw.iterative_scan', true) is not null then
    perform set_config('hnsw.iterative_scan', 'strict_order', true);
    perform set_config('hnsw.ef_search', '80', true);
    perform set_config('hnsw.max_scan_tuples', '10000', true);
    perform set_config('hnsw.scan_mem_multiplier', '1', true);
    return 'iterative';
  end if;

  if current_setting('hnsw.ef_search', true) is not null then
    perform set_config('hnsw.ef_search', '80', true);
    return 'ef_search';
  end if;

  return 'default';
end;
$$;

create or replace function public.qnotes_count_scoped_vector_candidates(
  p_owner_id uuid,
  p_filters jsonb,
  p_notebook_ids uuid[],
  p_allow_unfiled boolean,
  p_cap integer default 129
)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $$
  with filter_values as (
    select
      coalesce(
        (
          select array_agg(value)
            from jsonb_array_elements_text(coalesce(p_filters->'tags', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as tags,
      coalesce(
        (
          select array_agg(value)
            from jsonb_array_elements_text(coalesce(p_filters->'sourceTypes', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as source_types,
      coalesce(
        (
            select array_agg(lower(value))
              from jsonb_array_elements_text(coalesce(p_filters->'languages', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as languages,
      nullif(p_filters->>'updatedAfter', '')::timestamptz as updated_after,
      coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider') as embedding_mode
  ),
  eligible as (
    select d.id
      from notesdb.search_documents d
      join notesdb.notes n on n.id = d.note_id
        and n.owner_id = p_owner_id
        and n.deleted_at is null
      left join notesdb.note_blocks b on b.note_id = d.note_id
        and b.owner_id = p_owner_id
        and d.source_type in ('copy_block', 'code_block')
        and b.block_key = d.source_key
      cross join filter_values f
     where d.owner_id = p_owner_id
       and d.embedding_status = 'ready'
       and d.embedding is not null
       and d.embedding_model = 'gte-small'
       and d.embedding_model_version = 'v2'
       and d.embedding_mode = f.embedding_mode
       and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
       and (
         n.notebook_id = any(coalesce(p_notebook_ids, '{}'::uuid[]))
         or (coalesce(p_allow_unfiled, false) and n.notebook_id is null)
       )
       and (
         cardinality(f.tags) = 0
         or n.tags @> f.tags
       )
       and (
         cardinality(f.source_types) = 0
         or d.source_type = any(f.source_types)
       )
       and (
         cardinality(f.languages) = 0
         or lower(coalesce(b.language, '')) = any(f.languages)
       )
       and (
         f.updated_after is null
         or n.updated_at > f.updated_after
       )
     limit greatest(1, least(coalesce(p_cap, 129), 129))
  )
  select count(*)::integer
    from eligible;
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
)
returns table (
  id uuid, note_id uuid, note_slug text, note_title text, source_type text,
  source_id uuid, source_key text, source_title text, heading_path text,
  snippet text, score double precision, keyword_rank integer,
  semantic_rank integer, block_key text, language text, attachment_id uuid
)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  candidate_count integer;
  candidate_limit integer;
  use_exact boolean;
  old_enable_seqscan text;
  old_enable_indexscan text;
  old_enable_indexonlyscan text;
  old_enable_bitmapscan text;
begin
  old_enable_seqscan := current_setting('enable_seqscan');
  old_enable_indexscan := current_setting('enable_indexscan');
  old_enable_indexonlyscan := current_setting('enable_indexonlyscan');
  old_enable_bitmapscan := current_setting('enable_bitmapscan');
  candidate_count := public.qnotes_count_scoped_vector_candidates(
    p_owner_id,
    p_filters,
    p_notebook_ids,
    p_allow_unfiled,
    129
  );
  use_exact := candidate_count <= 128;
  candidate_limit := case
    when use_exact then greatest(candidate_count, 1)
    else greatest(50, least((greatest(p_offset, 0) + greatest(p_limit, 1)) * 5, 1000))
  end;

  begin
    perform public.qnotes_configure_hnsw_search(use_exact);
    if use_exact then
      -- Keep the small-set exact path off HNSW while retaining the operator
      -- ordering for the shared query body.
      perform set_config('enable_indexscan', 'off', true);
    end if;

    return query
      with params as (
        select
          greatest(1, least(coalesce(p_limit, 21), 1000)) as result_limit,
          greatest(0, coalesce(p_offset, 0)) as result_offset,
          greatest(1, least(coalesce(p_max_per_note, 2), 10)) as note_limit,
          candidate_limit as ann_candidate_limit,
          coalesce(p_notebook_ids, '{}'::uuid[]) as notebook_ids,
          coalesce(p_allow_unfiled, false) as allow_unfiled,
          p_owner_id as owner_id,
          p_embedding as embedding
      ),
      filter_values as (
        select
          coalesce(
            (
              select array_agg(value)
                from jsonb_array_elements_text(coalesce(p_filters->'tags', '[]'::jsonb)) as values(value)
            ),
            '{}'::text[]
          ) as tags,
          coalesce(
            (
              select array_agg(value)
                from jsonb_array_elements_text(coalesce(p_filters->'sourceTypes', '[]'::jsonb)) as values(value)
            ),
            '{}'::text[]
          ) as source_types,
          coalesce(
            (
              select array_agg(lower(value))
                from jsonb_array_elements_text(coalesce(p_filters->'languages', '[]'::jsonb)) as values(value)
            ),
            '{}'::text[]
          ) as languages,
          nullif(p_filters->>'updatedAfter', '')::timestamptz as updated_after,
          coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider') as embedding_mode
      ),
      semantic_candidates as materialized (
        select d.id, d.embedding <#> p_embedding as distance
        from notesdb.search_documents d
        join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
        left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
          and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
        cross join filter_values f
        where d.owner_id = p_owner_id and d.embedding_status = 'ready' and d.embedding is not null
          and d.embedding_model = 'gte-small' and d.embedding_model_version = 'v2'
          and d.embedding_mode = coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider')
          and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
          and (n.notebook_id = any(coalesce(p_notebook_ids, '{}'::uuid[])) or (coalesce(p_allow_unfiled, false) and n.notebook_id is null))
          and (cardinality(f.tags) = 0 or n.tags @> f.tags)
          and (cardinality(f.source_types) = 0 or d.source_type = any(f.source_types))
          and (cardinality(f.languages) = 0 or lower(coalesce(b.language, '')) = any(f.languages))
          and (f.updated_after is null or n.updated_at > f.updated_after)
        order by d.embedding <#> p_embedding
        limit candidate_limit
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
        select ranked.*, row_number() over (partition by ranked.note_id order by ranked.score desc, ranked.source_priority, ranked.id)::integer as note_rank
        from ranked
      )
      select r.id, r.note_id, r.note_slug, r.note_title, r.source_type, r.source_id, r.source_key,
        r.source_title, r.heading_path, public.qnotes_search_snippet(r.content, p_query),
        r.score, null::integer, r.semantic_rank, r.block_key, r.language, r.attachment_id
      from per_note r cross join params p
      where r.note_rank <= p.note_limit
      order by r.score desc, r.source_priority, r.id
      limit (select result_limit from params) offset (select result_offset from params);

    -- SET LOCAL remains transaction scoped; restore planner toggles before nested callers continue.
    perform set_config('enable_seqscan', old_enable_seqscan, true);
    perform set_config('enable_indexscan', 'on', true);
    perform set_config('enable_indexscan', old_enable_indexscan, true);
    perform set_config('enable_indexonlyscan', old_enable_indexonlyscan, true);
    perform set_config('enable_bitmapscan', old_enable_bitmapscan, true);
  exception when others then
    perform set_config('enable_seqscan', old_enable_seqscan, true);
    perform set_config('enable_indexscan', old_enable_indexscan, true);
    perform set_config('enable_indexonlyscan', old_enable_indexonlyscan, true);
    perform set_config('enable_bitmapscan', old_enable_bitmapscan, true);
    raise;
  end;
end;
$$;

create or replace function public.qnotes_semantic_search(
  p_owner_id uuid,
  p_query text,
  p_embedding extensions.vector(384),
  p_limit integer,
  p_filters jsonb,
  p_offset integer,
  p_max_per_note integer
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
  with requested as (
    select
      coalesce((select array_agg(item::uuid) from jsonb_array_elements_text(coalesce(p_filters->'notebookIds', '[]'::jsonb)) as items(item)), '{}'::uuid[]) as notebook_ids,
      coalesce((p_filters->>'unfiled')::boolean, false) as unfiled
  ),
  scope as (
    select
      case
        when cardinality(requested.notebook_ids) > 0 then requested.notebook_ids
        when requested.unfiled then '{}'::uuid[]
        else coalesce((select array_agg(n.id) from notesdb.notebooks n where n.owner_id = p_owner_id), '{}'::uuid[])
      end as notebook_ids,
      cardinality(requested.notebook_ids) = 0 as allow_unfiled
    from requested
  )
  select scoped.*
    from scope
    cross join lateral public.qnotes_semantic_search_scoped(
      p_owner_id,
      p_query,
      p_embedding,
      p_limit,
      p_filters,
      p_offset,
      p_max_per_note,
      scope.notebook_ids,
      scope.allow_unfiled
    ) scoped;
$$;

create or replace function public.qnotes_measure_tenant_vector_recall(
  p_owner_id uuid,
  p_embedding extensions.vector(384),
  p_filters jsonb default '{}'::jsonb,
  p_notebook_ids uuid[] default '{}',
  p_allow_unfiled boolean default false,
  p_k integer default 10
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  vector_version text;
  exact_ids uuid[];
  ann_ids uuid[];
  exact_started timestamptz;
  ann_started timestamptz;
  exact_ms double precision;
  ann_ms double precision;
  ann_mode text;
  overlap_count integer;
  old_enable_seqscan text;
  old_enable_indexscan text;
  old_enable_indexonlyscan text;
  old_enable_bitmapscan text;
  measurement_settings jsonb;
begin
  old_enable_seqscan := current_setting('enable_seqscan');
  old_enable_indexscan := current_setting('enable_indexscan');
  old_enable_indexonlyscan := current_setting('enable_indexonlyscan');
  old_enable_bitmapscan := current_setting('enable_bitmapscan');
  begin
    if p_embedding is null or p_k is null or p_k < 1 or p_k > 50 then
      raise exception using
        errcode = '22023',
        message = 'p_embedding is required and p_k must be between 1 and 50';
    end if;

  select extversion
    into vector_version
    from pg_extension
   where extname = 'vector';

  perform public.qnotes_configure_hnsw_search(true);
  exact_started := clock_timestamp();

  with filter_values as (
    select
      coalesce(
        (
          select array_agg(value)
            from jsonb_array_elements_text(coalesce(p_filters->'tags', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as tags,
      coalesce(
        (
          select array_agg(value)
            from jsonb_array_elements_text(coalesce(p_filters->'sourceTypes', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as source_types,
      coalesce(
        (
          select array_agg(lower(value))
            from jsonb_array_elements_text(coalesce(p_filters->'languages', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as languages,
      nullif(p_filters->>'updatedAfter', '')::timestamptz as updated_after,
      coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider') as embedding_mode
  ),
  exact_candidates as (
    select d.id, d.embedding <#> p_embedding as distance
      from notesdb.search_documents d
      join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
      left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
        and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
      cross join filter_values f
     where d.owner_id = p_owner_id
       and d.embedding_status = 'ready'
       and d.embedding is not null
       and d.embedding_model = 'gte-small'
       and d.embedding_model_version = 'v2'
       and d.embedding_mode = f.embedding_mode
       and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
       and (
         n.notebook_id = any(coalesce(p_notebook_ids, '{}'::uuid[]))
         or (coalesce(p_allow_unfiled, false) and n.notebook_id is null)
       )
       and (cardinality(f.tags) = 0 or n.tags @> f.tags)
       and (cardinality(f.source_types) = 0 or d.source_type = any(f.source_types))
       and (cardinality(f.languages) = 0 or lower(coalesce(b.language, '')) = any(f.languages))
       and (f.updated_after is null or n.updated_at > f.updated_after)
     order by (d.embedding <#> p_embedding) + 0, d.id
     limit p_k
  )
  select coalesce(array_agg(id order by distance, id), '{}'::uuid[])
    into exact_ids
    from exact_candidates;
  exact_ms := extract(epoch from clock_timestamp() - exact_started) * 1000;

  ann_mode := public.qnotes_configure_hnsw_search(false);
  perform set_config('enable_seqscan', 'off', true);
  perform set_config('enable_indexscan', 'on', true);
  perform set_config('enable_indexonlyscan', 'on', true);
  perform set_config('enable_bitmapscan', 'off', true);
  ann_started := clock_timestamp();

  with filter_values as (
    select
      coalesce(
        (
          select array_agg(value)
            from jsonb_array_elements_text(coalesce(p_filters->'tags', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as tags,
      coalesce(
        (
          select array_agg(value)
            from jsonb_array_elements_text(coalesce(p_filters->'sourceTypes', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as source_types,
      coalesce(
        (
          select array_agg(lower(value))
            from jsonb_array_elements_text(coalesce(p_filters->'languages', '[]'::jsonb)) as values(value)
        ),
        '{}'::text[]
      ) as languages,
      nullif(p_filters->>'updatedAfter', '')::timestamptz as updated_after,
      coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider') as embedding_mode
  ),
  ann_candidates as (
    select d.id, d.embedding <#> p_embedding as distance
      from notesdb.search_documents d
      join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
      left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
        and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
      cross join filter_values f
     where d.owner_id = p_owner_id
       and d.embedding_status = 'ready'
       and d.embedding is not null
       and d.embedding_model = 'gte-small'
       and d.embedding_model_version = 'v2'
       and d.embedding_mode = f.embedding_mode
       and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
       and (
         n.notebook_id = any(coalesce(p_notebook_ids, '{}'::uuid[]))
         or (coalesce(p_allow_unfiled, false) and n.notebook_id is null)
       )
       and (cardinality(f.tags) = 0 or n.tags @> f.tags)
       and (cardinality(f.source_types) = 0 or d.source_type = any(f.source_types))
       and (cardinality(f.languages) = 0 or lower(coalesce(b.language, '')) = any(f.languages))
       and (f.updated_after is null or n.updated_at > f.updated_after)
     order by d.embedding <#> p_embedding
     limit p_k
  )
  select coalesce(array_agg(id order by distance, id), '{}'::uuid[])
    into ann_ids
    from ann_candidates;
  ann_ms := extract(epoch from clock_timestamp() - ann_started) * 1000;

  select count(*)::integer
    into overlap_count
    from unnest(exact_ids) exact_id
   where exact_id = any(ann_ids);

  measurement_settings := jsonb_build_object(
    'iterativeScan', current_setting('hnsw.iterative_scan', true),
    'efSearch', current_setting('hnsw.ef_search', true),
    'maxScanTuples', current_setting('hnsw.max_scan_tuples', true),
    'scanMemMultiplier', current_setting('hnsw.scan_mem_multiplier', true),
    'seqscanDisabled', current_setting('enable_seqscan') = 'off',
    'indexscanEnabled', current_setting('enable_indexscan') = 'on'
  );
  perform set_config('enable_seqscan', old_enable_seqscan, true);
  perform set_config('enable_indexscan', old_enable_indexscan, true);
  perform set_config('enable_indexonlyscan', old_enable_indexonlyscan, true);
  perform set_config('enable_bitmapscan', old_enable_bitmapscan, true);

  return jsonb_build_object(
    'k', p_k,
    'exactIds', exact_ids,
    'annIds', ann_ids,
    'recallAtK', case
      when cardinality(exact_ids) = 0 then null
      else overlap_count::double precision / cardinality(exact_ids)
    end,
    'exactMs', exact_ms,
    'annMs', ann_ms,
    'pgvectorVersion', vector_version,
    'annConfiguration', ann_mode,
    'settings', measurement_settings
  );
  exception when others then
    perform set_config('enable_seqscan', old_enable_seqscan, true);
    perform set_config('enable_indexscan', old_enable_indexscan, true);
    perform set_config('enable_indexonlyscan', old_enable_indexonlyscan, true);
    perform set_config('enable_bitmapscan', old_enable_bitmapscan, true);
    raise;
  end;
end;
$$;

revoke all on function public.qnotes_configure_hnsw_search(boolean) from public, anon, authenticated;
grant execute on function public.qnotes_configure_hnsw_search(boolean) to service_role;

revoke all on function public.qnotes_count_scoped_vector_candidates(uuid, jsonb, uuid[], boolean, integer) from public, anon, authenticated;
grant execute on function public.qnotes_count_scoped_vector_candidates(uuid, jsonb, uuid[], boolean, integer) to service_role;

revoke all on function public.qnotes_measure_tenant_vector_recall(uuid, extensions.vector, jsonb, uuid[], boolean, integer) from public, anon, authenticated;
grant execute on function public.qnotes_measure_tenant_vector_recall(uuid, extensions.vector, jsonb, uuid[], boolean, integer) to service_role;
