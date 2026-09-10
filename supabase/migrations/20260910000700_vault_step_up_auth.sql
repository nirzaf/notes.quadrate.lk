-- US-05: verified step-up approvals and bounded new Vault agent lifetimes.

create table notesdb.vault_security_policy (
  policy_id boolean primary key default true check (policy_id),
  max_agent_token_lifetime_seconds bigint not null check (max_agent_token_lifetime_seconds between 60 and 31536000)
);

insert into notesdb.vault_security_policy (policy_id, max_agent_token_lifetime_seconds)
values (true, 7776000)
on conflict (policy_id) do nothing;

create table notesdb.vault_operation_approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  action text not null check (action in ('secret:reveal', 'secret:write', 'secret:delete', 'token:issue', 'token:revoke', 'grant:replace')),
  project_id uuid,
  environment_id uuid,
  secret_id uuid,
  expected_version bigint check (expected_version is null or expected_version > 0),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  approval_hash text not null unique check (approval_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index vault_operation_approvals_owner_created_key on notesdb.vault_operation_approvals (owner_id, created_at desc);
create index vault_operation_approvals_expiry_key on notesdb.vault_operation_approvals (expires_at) where used_at is null;

alter table notesdb.vault_security_policy enable row level security;
alter table notesdb.vault_operation_approvals enable row level security;
revoke all on table notesdb.vault_security_policy, notesdb.vault_operation_approvals from public, anon, authenticated;
grant all on table notesdb.vault_security_policy, notesdb.vault_operation_approvals to service_role;

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
  max_lifetime bigint;
begin
  select max_agent_token_lifetime_seconds into max_lifetime
  from notesdb.vault_security_policy
  where policy_id;
  if max_lifetime is null
    or p_expires_at is null
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + (max_lifetime * interval '1 second') then
    raise exception 'Vault agent token expiry is outside the configured policy';
  end if;
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

create or replace function public.qnotes_issue_vault_operation_approval(
  p_owner_id uuid,
  p_session_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_request_hash text,
  p_approval_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  expires_at timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if p_session_id is null
    or p_action is null
    or p_action not in ('secret:reveal', 'secret:write', 'secret:delete', 'token:issue', 'token:revoke', 'grant:replace')
    or (p_expected_version is not null and p_expected_version < 1)
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_approval_hash is null or p_approval_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid Vault operation approval';
  end if;
  insert into notesdb.vault_operation_approvals (owner_id, session_id, action, project_id, environment_id, secret_id, expected_version, request_hash, approval_hash, expires_at)
  values (p_owner_id, p_session_id, p_action, p_project_id, p_environment_id, p_secret_id, p_expected_version, p_request_hash, p_approval_hash, expires_at);
  return jsonb_build_object('status', 'ok', 'expiresAt', expires_at);
end;
$$;

create or replace function public.qnotes_consume_vault_operation_approval(
  p_owner_id uuid,
  p_session_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_request_hash text,
  p_approval_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare
  approval_row notesdb.vault_operation_approvals%rowtype;
begin
  select * into approval_row
  from notesdb.vault_operation_approvals
  where owner_id = p_owner_id and approval_hash = p_approval_hash
  for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if approval_row.used_at is not null then return jsonb_build_object('status', 'used'); end if;
  if approval_row.expires_at <= clock_timestamp() then return jsonb_build_object('status', 'expired'); end if;
  if approval_row.session_id is distinct from p_session_id
    or approval_row.action is distinct from p_action
    or approval_row.project_id is distinct from p_project_id
    or approval_row.environment_id is distinct from p_environment_id
    or approval_row.secret_id is distinct from p_secret_id
    or approval_row.expected_version is distinct from p_expected_version
    or approval_row.request_hash is distinct from p_request_hash then
    return jsonb_build_object('status', 'invalid');
  end if;
  update notesdb.vault_operation_approvals
  set used_at = clock_timestamp()
  where id = approval_row.id;
  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.qnotes_issue_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.qnotes_consume_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.qnotes_issue_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.qnotes_consume_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) to service_role;
