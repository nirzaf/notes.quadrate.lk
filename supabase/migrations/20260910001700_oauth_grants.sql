-- US-20: hosted OAuth grants are persisted separately from personal tokens.
-- The OAuth bearer carries only the grant reference and is resolved on every API request.
create table notesdb.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_token_id uuid not null references notesdb.api_tokens(id) on delete cascade,
  client_id text not null,
  resource text not null,
  scopes text[] not null,
  access_mode text not null,
  notebook_ids uuid[] not null default '{}'::uuid[],
  allow_unfiled boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint oauth_grants_client_id_check check (char_length(btrim(client_id)) between 1 and 4096),
  constraint oauth_grants_resource_check check (char_length(btrim(resource)) between 1 and 2048),
  constraint oauth_grants_scope_check check (scopes <@ array[
    'notes:read',
    'notes:write',
    'search:read',
    'shares:write',
    'attachments:read',
    'attachments:write'
  ]::text[]),
  constraint oauth_grants_scope_count_check check (cardinality(scopes) >= 1),
  constraint oauth_grants_access_mode_check check (access_mode in ('account', 'notebooks')),
  constraint oauth_grants_access_consistency_check check (access_mode <> 'account' or (allow_unfiled and cardinality(notebook_ids) = 0)),
  constraint oauth_grants_notebook_ids_check check (array_position(notebook_ids, null::uuid) is null)
);

create index oauth_grants_source_token_key on notesdb.oauth_grants (source_token_id, revoked_at, expires_at);
create index oauth_grants_owner_client_key on notesdb.oauth_grants (owner_id, client_id, resource, created_at desc);

alter table notesdb.oauth_grants enable row level security;
revoke all on table notesdb.oauth_grants from public, anon, authenticated;
grant all on table notesdb.oauth_grants to service_role;

create or replace function public.qnotes_create_oauth_grant(
  p_token_hash text,
  p_client_id text,
  p_resource text,
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
  source_notebook_ids uuid[] := '{}'::uuid[];
  requested_scopes text[];
  requested_notebook_ids uuid[] := coalesce(p_notebook_ids, '{}'::uuid[]);
  requested_access_mode text;
  requested_allow_unfiled boolean;
  grant_expiry timestamptz;
  grant_id uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_client_id is null or char_length(btrim(p_client_id)) not between 1 and 4096
    or p_resource is null or char_length(btrim(p_resource)) not between 1 and 2048 then
    raise exception 'oauth_invalid_token' using errcode = 'P0001';
  end if;

  select * into token_row
  from notesdb.api_tokens
  where token_hash = p_token_hash
    and revoked_at is null
    and (expires_at is null or expires_at > timezone('utc', now()));
  if not found then
    raise exception 'oauth_invalid_token' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct scope order by scope), '{}'::text[])
  into requested_scopes
  from unnest(coalesce(p_scopes, '{}'::text[])) as values(scope);
  if cardinality(requested_scopes) = 0 or not requested_scopes <@ token_row.scopes then
    raise exception 'oauth_scope_not_granted' using errcode = 'P0001';
  end if;

  if token_row.access_mode = 'notebooks' then
    select coalesce(array_agg(g.notebook_id order by g.notebook_id), '{}'::uuid[])
    into source_notebook_ids
    from notesdb.api_token_notebook_grants g
    where g.token_id = token_row.id and g.owner_id = token_row.owner_id;
  end if;

  requested_access_mode := coalesce(p_access_mode, token_row.access_mode);
  requested_allow_unfiled := coalesce(
    p_allow_unfiled,
    case
      when p_access_mode is null and token_row.access_mode = 'account' then true
      when p_access_mode is null then token_row.allow_unfiled
      else false
    end
  );
  if p_access_mode is null then requested_notebook_ids := source_notebook_ids; end if;

  if requested_access_mode = 'account' then
    if token_row.access_mode <> 'account'
      or requested_allow_unfiled is distinct from true
      or cardinality(requested_notebook_ids) > 0 then
      raise exception 'oauth_access_not_granted' using errcode = 'P0001';
    end if;
  elsif requested_access_mode = 'notebooks' then
    if requested_allow_unfiled is null then
      raise exception 'oauth_access_not_granted' using errcode = 'P0001';
    end if;
    if token_row.access_mode = 'notebooks' and (
      (requested_allow_unfiled and not token_row.allow_unfiled)
      or exists (
        select 1
        from unnest(requested_notebook_ids) as requested(notebook_id)
        where not requested.notebook_id = any(source_notebook_ids)
      )
    ) then
      raise exception 'oauth_access_not_granted' using errcode = 'P0001';
    end if;
    if exists (
      select 1
      from unnest(requested_notebook_ids) as requested(notebook_id)
      where not exists (
        select 1 from notesdb.notebooks n
        where n.id = requested.notebook_id and n.owner_id = token_row.owner_id
      )
    ) then
      raise exception 'oauth_access_not_granted' using errcode = 'P0001';
    end if;
  else
    raise exception 'oauth_access_not_granted' using errcode = 'P0001';
  end if;

  if p_expires_at is null or p_expires_at <= timezone('utc', now()) then
    raise exception 'oauth_expiry_invalid' using errcode = 'P0001';
  end if;
  grant_expiry := least(p_expires_at, coalesce(token_row.expires_at, p_expires_at));
  if grant_expiry <= timezone('utc', now()) then
    raise exception 'oauth_expiry_invalid' using errcode = 'P0001';
  end if;

  insert into notesdb.oauth_grants (
    owner_id, source_token_id, client_id, resource, scopes, access_mode,
    notebook_ids, allow_unfiled, expires_at
  ) values (
    token_row.owner_id, token_row.id, btrim(p_client_id), btrim(p_resource),
    requested_scopes, requested_access_mode, requested_notebook_ids,
    case when requested_access_mode = 'account' then true else requested_allow_unfiled end,
    grant_expiry
  ) returning id into grant_id;

  return jsonb_build_object(
    'id', grant_id,
    'owner_id', token_row.owner_id,
    'scopes', requested_scopes,
    'access_mode', requested_access_mode,
    'allow_unfiled', case when requested_access_mode = 'account' then true else requested_allow_unfiled end,
    'notebook_ids', requested_notebook_ids,
    'expires_at', grant_expiry
  );
end;
$$;

create or replace function public.qnotes_oauth_grant_context(
  p_grant_id uuid,
  p_client_id text,
  p_resource text
) returns table (
  owner_id uuid,
  scopes text[],
  access_mode text,
  allow_unfiled boolean,
  policy_revision bigint,
  notebook_ids uuid[],
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  grant_row notesdb.oauth_grants%rowtype;
  token_row notesdb.api_tokens%rowtype;
  effective_scopes text[];
  effective_notebook_ids uuid[] := '{}'::uuid[];
begin
  select g.* into grant_row
  from notesdb.oauth_grants g
  where g.id = p_grant_id
    and g.client_id = p_client_id
    and g.resource = p_resource
    and g.revoked_at is null
    and g.expires_at > timezone('utc', now());
  if not found then return; end if;

  select * into token_row
  from notesdb.api_tokens t
  where t.id = grant_row.source_token_id
    and t.owner_id = grant_row.owner_id
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > timezone('utc', now()));
  if not found then return; end if;

  select coalesce(array_agg(scope order by scope), '{}'::text[])
  into effective_scopes
  from unnest(grant_row.scopes) as requested(scope)
  where scope = any(token_row.scopes);
  if cardinality(effective_scopes) = 0 then return; end if;

  if grant_row.access_mode = 'account' then
    if token_row.access_mode <> 'account' then return; end if;
    return query select grant_row.owner_id, effective_scopes, 'account', true,
      token_row.policy_revision, '{}'::uuid[], grant_row.expires_at;
    return;
  end if;

  if token_row.access_mode = 'account' then
    select coalesce(array_agg(requested.notebook_id order by requested.notebook_id), '{}'::uuid[])
    into effective_notebook_ids
    from unnest(grant_row.notebook_ids) as requested(notebook_id)
    where exists (
      select 1 from notesdb.notebooks n
      where n.id = requested.notebook_id and n.owner_id = grant_row.owner_id
    );
  else
    select coalesce(array_agg(requested.notebook_id order by requested.notebook_id), '{}'::uuid[])
    into effective_notebook_ids
    from unnest(grant_row.notebook_ids) as requested(notebook_id)
    where requested.notebook_id = any(coalesce((
      select array_agg(g.notebook_id)
      from notesdb.api_token_notebook_grants g
      where g.token_id = token_row.id and g.owner_id = token_row.owner_id
    ), '{}'::uuid[]))
    and exists (
      select 1 from notesdb.notebooks n
      where n.id = requested.notebook_id and n.owner_id = grant_row.owner_id
    );
  end if;

  return query select grant_row.owner_id, effective_scopes, 'notebooks',
    grant_row.allow_unfiled and (token_row.access_mode = 'account' or token_row.allow_unfiled),
    token_row.policy_revision, effective_notebook_ids, grant_row.expires_at;
end;
$$;

create or replace function public.qnotes_revoke_oauth_grant(
  p_grant_id uuid,
  p_client_id text,
  p_resource text
) returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  with revoked as (
    update notesdb.oauth_grants
    set revoked_at = coalesce(revoked_at, timezone('utc', now()))
    where id = p_grant_id
      and client_id = p_client_id
      and resource = p_resource
      and revoked_at is null
    returning id
  )
  select exists(select 1 from revoked);
$$;

create or replace function public.qnotes_purge_expired_oauth_grants(
  p_limit integer default 500
) returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  deleted_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'oauth purge limit must be between 1 and 1000' using errcode = '22023';
  end if;

  with candidates as (
    select id
    from notesdb.oauth_grants
    where expires_at <= timezone('utc', now())
      or revoked_at <= timezone('utc', now()) - interval '1 day'
    order by coalesce(revoked_at, expires_at), id
    limit p_limit
    for update skip locked
  )
  delete from notesdb.oauth_grants g
  using candidates
  where g.id = candidates.id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

do $oauth_cleanup$
begin
  if not exists (select 1 from cron.job where jobname = 'qnotes-purge-oauth-grants') then
    perform cron.schedule(
      'qnotes-purge-oauth-grants',
      '17 * * * *',
      $$select public.qnotes_purge_expired_oauth_grants(500);$$
    );
  end if;
end;
$oauth_cleanup$;

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'qnotes_create_oauth_grant(text,text,text,text[],timestamptz,text,boolean,uuid[])',
    'qnotes_oauth_grant_context(uuid,text,text)',
    'qnotes_revoke_oauth_grant(uuid,text,text)',
    'qnotes_purge_expired_oauth_grants(integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', signature);
    execute format('grant execute on function public.%s to service_role', signature);
  end loop;
end;
$$;
