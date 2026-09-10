-- Agent Vault v1 is an additive, service-mediated metadata plane over
-- Supabase Vault. No secret value is stored in notesdb.

create table notesdb.vault_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  name text not null,
  description text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  archived_at timestamptz null,
  unique (id, owner_id),
  constraint vault_projects_slug_check check (slug ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  constraint vault_projects_name_check check (char_length(name) between 1 and 80),
  constraint vault_projects_description_check check (description is null or char_length(description) <= 500)
);

create unique index vault_projects_active_slug_key on notesdb.vault_projects (owner_id, lower(slug)) where archived_at is null;
create index vault_projects_owner_created_key on notesdb.vault_projects (owner_id, created_at desc);

create table notesdb.vault_environments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid not null,
  slug text not null,
  name text not null,
  description text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  archived_at timestamptz null,
  unique (id, owner_id),
  unique (id, project_id, owner_id),
  foreign key (project_id, owner_id) references notesdb.vault_projects(id, owner_id) on delete cascade,
  constraint vault_environments_slug_check check (slug ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  constraint vault_environments_name_check check (char_length(name) between 1 and 80),
  constraint vault_environments_description_check check (description is null or char_length(description) <= 500)
);

create unique index vault_environments_active_slug_key on notesdb.vault_environments (project_id, lower(slug)) where archived_at is null;
create index vault_environments_owner_project_key on notesdb.vault_environments (owner_id, project_id, created_at desc);

create table notesdb.vault_secrets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid not null,
  environment_id uuid not null,
  name text not null,
  description text null,
  vault_secret_id uuid not null unique,
  version bigint not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  rotated_at timestamptz null,
  deleted_at timestamptz null,
  unique (id, owner_id),
  unique (id, environment_id, project_id, owner_id),
  foreign key (project_id, owner_id) references notesdb.vault_projects(id, owner_id) on delete cascade,
  foreign key (environment_id, project_id, owner_id) references notesdb.vault_environments(id, project_id, owner_id) on delete cascade,
  constraint vault_secrets_name_check check (name ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'),
  constraint vault_secrets_description_check check (description is null or char_length(description) <= 500),
  constraint vault_secrets_version_check check (version > 0)
);

create unique index vault_secrets_active_name_key on notesdb.vault_secrets (environment_id, lower(name)) where deleted_at is null;
create index vault_secrets_owner_environment_key on notesdb.vault_secrets (owner_id, environment_id, updated_at desc);

create table notesdb.vault_agent_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_prefix text not null,
  token_hash text not null unique,
  expires_at timestamptz null,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, owner_id),
  constraint vault_agent_tokens_name_check check (char_length(name) between 1 and 80),
  constraint vault_agent_tokens_prefix_check check (token_prefix ~ '^qvt_[A-Za-z0-9_-]{8}$'),
  constraint vault_agent_tokens_hash_check check (token_hash ~ '^[a-f0-9]{64}$')
);

create index vault_agent_tokens_owner_created_key on notesdb.vault_agent_tokens (owner_id, created_at desc);

create table notesdb.vault_agent_grants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  token_id uuid not null,
  project_id uuid not null,
  environment_id uuid null,
  secret_id uuid null,
  action text not null,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (token_id, owner_id) references notesdb.vault_agent_tokens(id, owner_id) on delete cascade,
  foreign key (project_id, owner_id) references notesdb.vault_projects(id, owner_id) on delete cascade,
  foreign key (environment_id, project_id, owner_id) references notesdb.vault_environments(id, project_id, owner_id) on delete cascade,
  foreign key (secret_id, environment_id, project_id, owner_id) references notesdb.vault_secrets(id, environment_id, project_id, owner_id) on delete cascade,
  constraint vault_agent_grants_scope_check check (secret_id is null or environment_id is not null),
  constraint vault_agent_grants_action_check check (action in ('metadata:read', 'secret:reveal', 'secret:write', 'secret:delete'))
);

create index vault_agent_grants_token_scope_key on notesdb.vault_agent_grants (token_id, owner_id, project_id, action);

create table notesdb.vault_audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor_kind text not null,
  actor_token_id uuid null,
  action text not null,
  project_id uuid null,
  environment_id uuid null,
  secret_id uuid null,
  purpose text null,
  success boolean not null,
  result_code text null,
  request_id uuid null,
  occurred_at timestamptz not null default timezone('utc', now()),
  constraint vault_audit_actor_kind_check check (actor_kind in ('user_jwt', 'vault_agent')),
  constraint vault_audit_action_check check (action in ('metadata:read', 'secret:reveal', 'secret:write', 'secret:delete')),
  constraint vault_audit_purpose_check check (purpose is null or char_length(purpose) <= 200),
  constraint vault_audit_result_code_check check (result_code is null or result_code !~ '[\r\n]')
);

create index vault_audit_owner_occurred_key on notesdb.vault_audit_events (owner_id, occurred_at desc);

create table notesdb.vault_mutations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  operation text not null,
  request_hash text not null,
  secret_id uuid null,
  resulting_version bigint null,
  response jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (owner_id, mutation_id),
  constraint vault_mutations_hash_check check (request_hash ~ '^[a-f0-9]{64}$')
);

create index vault_mutations_owner_created_key on notesdb.vault_mutations (owner_id, created_at desc);

alter table notesdb.vault_projects enable row level security;
alter table notesdb.vault_environments enable row level security;
alter table notesdb.vault_secrets enable row level security;
alter table notesdb.vault_agent_tokens enable row level security;
alter table notesdb.vault_agent_grants enable row level security;
alter table notesdb.vault_audit_events enable row level security;
alter table notesdb.vault_mutations enable row level security;

revoke all on table notesdb.vault_projects, notesdb.vault_environments, notesdb.vault_secrets, notesdb.vault_agent_tokens, notesdb.vault_agent_grants, notesdb.vault_audit_events, notesdb.vault_mutations from public, anon, authenticated;
grant all on table notesdb.vault_projects, notesdb.vault_environments, notesdb.vault_secrets, notesdb.vault_agent_tokens, notesdb.vault_agent_grants, notesdb.vault_audit_events, notesdb.vault_mutations to service_role;
revoke all on table vault.secrets, vault.decrypted_secrets from public, anon, authenticated;

create or replace function public.qnotes_vault_create_secret(
  p_owner_id uuid,
  p_project_id uuid,
  p_environment_id uuid,
  p_name text,
  p_description text,
  p_value text,
  p_mutation_id uuid,
  p_request_hash text,
  p_actor_token_id uuid,
  p_request_id uuid,
  p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  project_row notesdb.vault_projects%rowtype;
  environment_row notesdb.vault_environments%rowtype;
  stored notesdb.vault_mutations%rowtype;
  secret_row notesdb.vault_secrets%rowtype;
  vault_id uuid;
  response jsonb;
begin
  select * into stored from notesdb.vault_mutations where owner_id = p_owner_id and mutation_id = p_mutation_id for update;
  if found then
    if stored.operation = 'created' and stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent') || stored.response;
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;

  select * into project_row from notesdb.vault_projects where id = p_project_id and owner_id = p_owner_id and archived_at is null;
  if not found then return jsonb_build_object('status', 'project_not_found'); end if;
  select * into environment_row from notesdb.vault_environments where id = p_environment_id and project_id = p_project_id and owner_id = p_owner_id and archived_at is null;
  if not found then return jsonb_build_object('status', 'environment_not_found'); end if;
  if char_length(p_name) < 1 or char_length(p_name) > 128 or p_name !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$' then return jsonb_build_object('status', 'invalid_name'); end if;
  if p_value is null or octet_length(p_value) > 65536 then return jsonb_build_object('status', 'secret_too_large'); end if;
  if p_actor_kind not in ('user_jwt', 'vault_agent') then raise exception 'invalid Vault actor'; end if;

  if exists (select 1 from notesdb.vault_secrets where environment_id = p_environment_id and lower(name) = lower(p_name) and deleted_at is null) then
    return jsonb_build_object('status', 'secret_conflict');
  end if;

  secret_row.id := gen_random_uuid();
  select vault.create_secret(p_value, 'qnotes-vault-' || secret_row.id::text, p_description) into vault_id;
  insert into notesdb.vault_secrets (id, owner_id, project_id, environment_id, name, description, vault_secret_id)
  values (secret_row.id, p_owner_id, p_project_id, p_environment_id, p_name, p_description, vault_id)
  returning * into secret_row;
  response := jsonb_build_object('secret', jsonb_build_object('id', secret_row.id, 'projectId', secret_row.project_id, 'environmentId', secret_row.environment_id, 'name', secret_row.name, 'description', secret_row.description, 'version', secret_row.version, 'createdAt', secret_row.created_at, 'updatedAt', secret_row.updated_at, 'rotatedAt', secret_row.rotated_at, 'deletedAt', secret_row.deleted_at));
  perform public.qnotes_vault_append_audit_event(
    p_owner_id, p_actor_kind, p_actor_token_id, 'secret:write', p_project_id,
    p_environment_id, secret_row.id, null, true, 'created', p_request_id, p_request_id, null
  );
  insert into notesdb.vault_mutations (owner_id, mutation_id, operation, request_hash, secret_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'created', p_request_hash, secret_row.id, secret_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_vault_rotate_secret(
  p_owner_id uuid,
  p_secret_id uuid,
  p_value text,
  p_description text,
  p_expected_version bigint,
  p_mutation_id uuid,
  p_request_hash text,
  p_actor_token_id uuid,
  p_request_id uuid,
  p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  secret_row notesdb.vault_secrets%rowtype;
  stored notesdb.vault_mutations%rowtype;
  response jsonb;
begin
  select * into stored from notesdb.vault_mutations where owner_id = p_owner_id and mutation_id = p_mutation_id for update;
  if found then
    if stored.operation = 'rotated' and stored.request_hash = p_request_hash then return jsonb_build_object('status', 'idempotent') || stored.response; end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;
  select * into secret_row from notesdb.vault_secrets where id = p_secret_id and owner_id = p_owner_id for update;
  if not found or secret_row.deleted_at is not null then return jsonb_build_object('status', 'not_found'); end if;
  if secret_row.version <> p_expected_version then return jsonb_build_object('status', 'version_conflict', 'currentVersion', secret_row.version); end if;
  if p_value is null or octet_length(p_value) > 65536 then return jsonb_build_object('status', 'secret_too_large'); end if;
  if p_actor_kind not in ('user_jwt', 'vault_agent') then raise exception 'invalid Vault actor'; end if;

  perform vault.update_secret(secret_row.vault_secret_id, p_value, 'qnotes-vault-' || secret_row.id::text, coalesce(p_description, secret_row.description));
  update notesdb.vault_secrets
  set description = coalesce(p_description, description), version = version + 1, rotated_at = timezone('utc', now()), updated_at = timezone('utc', now())
  where id = secret_row.id and owner_id = p_owner_id
  returning * into secret_row;
  response := jsonb_build_object('secret', jsonb_build_object('id', secret_row.id, 'projectId', secret_row.project_id, 'environmentId', secret_row.environment_id, 'name', secret_row.name, 'description', secret_row.description, 'version', secret_row.version, 'createdAt', secret_row.created_at, 'updatedAt', secret_row.updated_at, 'rotatedAt', secret_row.rotated_at, 'deletedAt', secret_row.deleted_at));
  perform public.qnotes_vault_append_audit_event(
    p_owner_id, p_actor_kind, p_actor_token_id, 'secret:write', secret_row.project_id,
    secret_row.environment_id, secret_row.id, null, true, 'rotated', p_request_id, p_request_id, null
  );
  insert into notesdb.vault_mutations (owner_id, mutation_id, operation, request_hash, secret_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'rotated', p_request_hash, secret_row.id, secret_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_vault_delete_secret(
  p_owner_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_mutation_id uuid,
  p_request_hash text,
  p_actor_token_id uuid,
  p_request_id uuid,
  p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  secret_row notesdb.vault_secrets%rowtype;
  stored notesdb.vault_mutations%rowtype;
  response jsonb;
begin
  select * into stored from notesdb.vault_mutations where owner_id = p_owner_id and mutation_id = p_mutation_id for update;
  if found then
    if stored.operation = 'deleted' and stored.request_hash = p_request_hash then return jsonb_build_object('status', 'idempotent') || stored.response; end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;
  select * into secret_row from notesdb.vault_secrets where id = p_secret_id and owner_id = p_owner_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if secret_row.version <> p_expected_version then return jsonb_build_object('status', 'version_conflict', 'currentVersion', secret_row.version); end if;
  if secret_row.deleted_at is not null then return jsonb_build_object('status', 'not_found'); end if;
  if p_actor_kind not in ('user_jwt', 'vault_agent') then raise exception 'invalid Vault actor'; end if;

  delete from vault.secrets where id = secret_row.vault_secret_id;
  if not found then raise exception 'Vault value unavailable'; end if;
  update notesdb.vault_secrets set deleted_at = timezone('utc', now()), version = version + 1, updated_at = timezone('utc', now()) where id = secret_row.id and owner_id = p_owner_id returning * into secret_row;
  response := jsonb_build_object('secret', jsonb_build_object('id', secret_row.id, 'projectId', secret_row.project_id, 'environmentId', secret_row.environment_id, 'name', secret_row.name, 'description', secret_row.description, 'version', secret_row.version, 'createdAt', secret_row.created_at, 'updatedAt', secret_row.updated_at, 'rotatedAt', secret_row.rotated_at, 'deletedAt', secret_row.deleted_at));
  perform public.qnotes_vault_append_audit_event(
    p_owner_id, p_actor_kind, p_actor_token_id, 'secret:delete', secret_row.project_id,
    secret_row.environment_id, secret_row.id, null, true, 'deleted', p_request_id, p_request_id, null
  );
  insert into notesdb.vault_mutations (owner_id, mutation_id, operation, request_hash, secret_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'deleted', p_request_hash, secret_row.id, secret_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_vault_reveal_secret(
  p_owner_id uuid,
  p_secret_id uuid,
  p_actor_token_id uuid,
  p_purpose text,
  p_request_id uuid,
  p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  secret_row record;
  secret_value text;
begin
  if p_purpose is null or char_length(p_purpose) < 1 or char_length(p_purpose) > 200 then raise exception 'invalid Vault purpose'; end if;
  if p_actor_kind not in ('user_jwt', 'vault_agent') then raise exception 'invalid Vault actor'; end if;
  select s.id, s.project_id, s.environment_id, s.name, s.version, s.updated_at, s.vault_secret_id, p.slug as project_slug, e.slug as environment_slug
  into secret_row
  from notesdb.vault_secrets s
  join notesdb.vault_projects p on p.id = s.project_id and p.owner_id = s.owner_id
  join notesdb.vault_environments e on e.id = s.environment_id and e.project_id = s.project_id and e.owner_id = s.owner_id
  where s.id = p_secret_id and s.owner_id = p_owner_id and s.deleted_at is null and p.archived_at is null and e.archived_at is null;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select decrypted_secret into secret_value from vault.decrypted_secrets where id = secret_row.vault_secret_id;
  if not found then return jsonb_build_object('status', 'vault_missing'); end if;
  perform public.qnotes_vault_append_audit_event(
    p_owner_id, p_actor_kind, p_actor_token_id, 'secret:reveal', secret_row.project_id,
    secret_row.environment_id, secret_row.id, p_purpose, true, 'revealed', p_request_id, p_request_id, null
  );
  return jsonb_build_object('status', 'ok', 'secret', jsonb_build_object('secretId', secret_row.id, 'project', secret_row.project_slug, 'environment', secret_row.environment_slug, 'name', secret_row.name, 'value', secret_value, 'version', secret_row.version, 'updatedAt', secret_row.updated_at));
end;
$$;

create or replace function public.qnotes_create_vault_agent_token(
  p_owner_id uuid,
  p_name text,
  p_token_prefix text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_grants jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  token_row notesdb.vault_agent_tokens%rowtype;
  grant_item jsonb;
  grant_row notesdb.vault_agent_grants%rowtype;
  grants jsonb := '[]'::jsonb;
begin
  if p_name is null or char_length(p_name) < 1 or char_length(p_name) > 80 or p_token_prefix !~ '^qvt_[A-Za-z0-9_-]{8}$' or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid Vault agent token metadata'; end if;
  insert into notesdb.vault_agent_tokens (owner_id, name, token_prefix, token_hash, expires_at) values (p_owner_id, p_name, p_token_prefix, p_token_hash, p_expires_at) returning * into token_row;
  for grant_item in select value from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) loop
    if (grant_item->>'secretId' is not null and grant_item->>'secretId' <> '' and (grant_item->>'environmentId' is null or grant_item->>'environmentId' = '')) then
      raise exception 'Vault secret grant requires an environment';
    end if;
    insert into notesdb.vault_agent_grants (owner_id, token_id, project_id, environment_id, secret_id, action)
    values (p_owner_id, token_row.id, (grant_item->>'projectId')::uuid, nullif(grant_item->>'environmentId', '')::uuid, nullif(grant_item->>'secretId', '')::uuid, grant_item->>'action')
    returning * into grant_row;
    grants := grants || jsonb_build_array(jsonb_build_object('id', grant_row.id, 'projectId', grant_row.project_id, 'environmentId', grant_row.environment_id, 'secretId', grant_row.secret_id, 'action', grant_row.action, 'createdAt', grant_row.created_at));
  end loop;
  return jsonb_build_object('id', token_row.id, 'name', token_row.name, 'tokenPrefix', token_row.token_prefix, 'expiresAt', token_row.expires_at, 'lastUsedAt', token_row.last_used_at, 'revokedAt', token_row.revoked_at, 'createdAt', token_row.created_at, 'grants', grants);
end;
$$;

create or replace function public.qnotes_replace_vault_agent_grants(
  p_owner_id uuid,
  p_token_id uuid,
  p_grants jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  token_row notesdb.vault_agent_tokens%rowtype;
  grant_item jsonb;
  grant_row notesdb.vault_agent_grants%rowtype;
  grants jsonb := '[]'::jsonb;
begin
  select * into token_row from notesdb.vault_agent_tokens where id = p_token_id and owner_id = p_owner_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  delete from notesdb.vault_agent_grants where token_id = p_token_id and owner_id = p_owner_id;
  for grant_item in select value from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) loop
    if (grant_item->>'secretId' is not null and grant_item->>'secretId' <> '') and (grant_item->>'environmentId' is null or grant_item->>'environmentId' = '') then raise exception 'Vault secret grant requires an environment'; end if;
    insert into notesdb.vault_agent_grants (owner_id, token_id, project_id, environment_id, secret_id, action)
    values (p_owner_id, p_token_id, (grant_item->>'projectId')::uuid, nullif(grant_item->>'environmentId', '')::uuid, nullif(grant_item->>'secretId', '')::uuid, grant_item->>'action')
    returning * into grant_row;
    grants := grants || jsonb_build_array(jsonb_build_object('id', grant_row.id, 'projectId', grant_row.project_id, 'environmentId', grant_row.environment_id, 'secretId', grant_row.secret_id, 'action', grant_row.action, 'createdAt', grant_row.created_at));
  end loop;
  return jsonb_build_object('status', 'ok', 'grants', grants);
end;
$$;

revoke all on function public.qnotes_vault_create_secret(uuid, uuid, uuid, text, text, text, uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_delete_secret(uuid, uuid, bigint, uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_reveal_secret(uuid, uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qnotes_vault_create_secret(uuid, uuid, uuid, text, text, text, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_delete_secret(uuid, uuid, bigint, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_reveal_secret(uuid, uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb) to service_role;
