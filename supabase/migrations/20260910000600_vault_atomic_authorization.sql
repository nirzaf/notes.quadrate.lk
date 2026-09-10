-- Keep the current Vault deployment, but make secret RPC authorization
-- linearizable with token revocation and grant replacement.

create or replace function public.qnotes_vault_record_denial(
  p_owner_id uuid,
  p_actor_token_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_request_id uuid,
  p_result_code text
) returns void
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  -- Existing user-JWT routes keep their no-audit failure behavior; agent
  -- denials are recorded here because the token is the security principal.
  if p_actor_token_id is null then
    return;
  end if;
  if p_owner_id is null
    or p_action not in ('metadata:read', 'secret:reveal', 'secret:write', 'secret:delete')
    or not exists (select 1 from auth.users where id = p_owner_id) then
    return;
  end if;

  insert into notesdb.vault_audit_events (
    owner_id, actor_kind, actor_token_id, action, project_id, environment_id,
    secret_id, success, result_code, request_id
  ) values (
    p_owner_id,
    case when p_actor_token_id is null then 'user_jwt' else 'vault_agent' end,
    p_actor_token_id,
    p_action,
    p_project_id,
    p_environment_id,
    p_secret_id,
    false,
    left(regexp_replace(coalesce(p_result_code, 'access_denied'), '[\r\n]', '', 'g'), 100),
    p_request_id
  );
end;
$$;

create or replace function public.qnotes_vault_authorize_actor(
  p_owner_id uuid,
  p_actor_token_id uuid,
  p_actor_kind text,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare
  token_row notesdb.vault_agent_tokens%rowtype;
  project_row notesdb.vault_projects%rowtype;
  environment_row notesdb.vault_environments%rowtype;
  secret_row notesdb.vault_secrets%rowtype;
begin
  if p_action not in ('metadata:read', 'secret:reveal', 'secret:write', 'secret:delete') then
    perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'invalid_action');
    return jsonb_build_object('status', 'access_denied');
  end if;

  if p_actor_token_id is null then
    if p_actor_kind <> 'user_jwt' then
      perform public.qnotes_vault_record_denial(p_owner_id, null, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'invalid_actor');
      return jsonb_build_object('status', 'access_denied');
    end if;
  else
    if p_actor_kind <> 'vault_agent' then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'invalid_actor');
      return jsonb_build_object('status', 'access_denied');
    end if;

    -- Linearization point: revocation and grant replacement lock this row too.
    select * into token_row
    from notesdb.vault_agent_tokens
    where id = p_actor_token_id and owner_id = p_owner_id
    for update;
    if not found
      or token_row.revoked_at is not null
      or (token_row.expires_at is not null and token_row.expires_at <= clock_timestamp()) then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'token_invalid');
      return jsonb_build_object('status', 'access_denied');
    end if;
  end if;

  if p_secret_id is null then
    select * into project_row
    from notesdb.vault_projects
    where id = p_project_id and owner_id = p_owner_id and archived_at is null
    for update;
    if not found then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, null, p_request_id, 'not_found');
      return jsonb_build_object('status', 'project_not_found');
    end if;

    select * into environment_row
    from notesdb.vault_environments
    where id = p_environment_id and project_id = p_project_id and owner_id = p_owner_id and archived_at is null
    for update;
    if not found then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, null, p_request_id, 'not_found');
      return jsonb_build_object('status', 'environment_not_found');
    end if;
  else
    -- Secret rows are locked after the token and before receipts/audit rows.
    select * into secret_row
    from notesdb.vault_secrets
    where id = p_secret_id and owner_id = p_owner_id
    for update;
    if not found then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
      return jsonb_build_object('status', 'not_found');
    end if;
    if (p_project_id is not null and secret_row.project_id is distinct from p_project_id)
      or (p_environment_id is not null and secret_row.environment_id is distinct from p_environment_id) then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
      return jsonb_build_object('status', 'not_found');
    end if;
    -- Secret-scoped wrappers resolve their project and environment from the locked row.
    p_project_id := secret_row.project_id;
    p_environment_id := secret_row.environment_id;

    select * into project_row
    from notesdb.vault_projects
    where id = secret_row.project_id and owner_id = p_owner_id and archived_at is null
    for update;
    select * into environment_row
    from notesdb.vault_environments
    where id = secret_row.environment_id and project_id = secret_row.project_id and owner_id = p_owner_id and archived_at is null
    for update;
    if not found then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
      return jsonb_build_object('status', 'not_found');
    end if;
  end if;

  if p_actor_token_id is not null and not exists (
    select 1
    from notesdb.vault_agent_grants g
    where g.owner_id = p_owner_id
      and g.token_id = p_actor_token_id
      and g.project_id = p_project_id
      and g.action = p_action
      and (
        (p_environment_id is null and g.environment_id is null and g.secret_id is null)
        or (
          p_environment_id is not null
          and (g.environment_id is null or g.environment_id = p_environment_id)
          and (
            (p_secret_id is null and g.secret_id is null)
            or (p_secret_id is not null and (g.secret_id is null or g.secret_id = p_secret_id))
          )
        )
      )
  ) then
    perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'grant_denied');
    return jsonb_build_object('status', 'access_denied');
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.qnotes_vault_authorize_batch(
  p_owner_id uuid,
  p_selectors jsonb,
  p_actor_token_id uuid,
  p_actor_kind text,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare
  token_row notesdb.vault_agent_tokens%rowtype;
  secret_row notesdb.vault_secrets%rowtype;
  selector_item jsonb;
  selector_project_id uuid;
  selector_environment_id uuid;
  selector_secret_id uuid;
  selector_ids uuid[] := '{}'::uuid[];
  resolved_ids uuid[] := '{}'::uuid[];
  resolved_selectors jsonb := '[]'::jsonb;
begin
  if p_actor_token_id is null then
    if p_actor_kind <> 'user_jwt' then
      perform public.qnotes_vault_record_denial(p_owner_id, null, 'secret:reveal', null, null, null, p_request_id, 'invalid_actor');
      return jsonb_build_object('status', 'access_denied');
    end if;
  else
    if p_actor_kind <> 'vault_agent' then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, 'secret:reveal', null, null, null, p_request_id, 'invalid_actor');
      return jsonb_build_object('status', 'access_denied');
    end if;
    select * into token_row
    from notesdb.vault_agent_tokens
    where id = p_actor_token_id and owner_id = p_owner_id
    for update;
    if not found
      or token_row.revoked_at is not null
      or (token_row.expires_at is not null and token_row.expires_at <= clock_timestamp()) then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, 'secret:reveal', null, null, null, p_request_id, 'token_invalid');
      return jsonb_build_object('status', 'access_denied');
    end if;
  end if;

  if p_selectors is null or jsonb_typeof(p_selectors) <> 'array' or jsonb_array_length(p_selectors) < 1 or jsonb_array_length(p_selectors) > 20 then
    perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, 'secret:reveal', null, null, null, p_request_id, 'invalid_selectors');
    return jsonb_build_object('status', 'invalid_selectors');
  end if;

  -- Parse every selector before taking secret locks, then lock unique rows by ID.
  for selector_item in select value from jsonb_array_elements(p_selectors)
  loop
    if jsonb_typeof(selector_item) <> 'object'
      or selector_item->>'projectId' is null
      or selector_item->>'environmentId' is null
      or selector_item->>'secretId' is null then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, 'secret:reveal', null, null, null, p_request_id, 'invalid_selectors');
      return jsonb_build_object('status', 'invalid_selectors');
    end if;
    begin
      selector_project_id := (selector_item->>'projectId')::uuid;
      selector_environment_id := (selector_item->>'environmentId')::uuid;
      selector_secret_id := (selector_item->>'secretId')::uuid;
    exception when invalid_text_representation then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, 'secret:reveal', null, null, null, p_request_id, 'invalid_selectors');
      return jsonb_build_object('status', 'invalid_selectors');
    end;
    if not selector_secret_id = any(selector_ids) then
      selector_ids := array_append(selector_ids, selector_secret_id);
    end if;
  end loop;

  for secret_row in
    select * from notesdb.vault_secrets
    where owner_id = p_owner_id and id = any(selector_ids)
    order by id
    for update
  loop
    null;
  end loop;

  for selector_item in
    select value from jsonb_array_elements(p_selectors)
    order by (value->>'secretId')::uuid
  loop
    selector_project_id := (selector_item->>'projectId')::uuid;
    selector_environment_id := (selector_item->>'environmentId')::uuid;
    selector_secret_id := (selector_item->>'secretId')::uuid;
    select s.* into secret_row
    from notesdb.vault_secrets s
    join notesdb.vault_projects p on p.id = s.project_id and p.owner_id = s.owner_id and p.archived_at is null
    join notesdb.vault_environments e on e.id = s.environment_id and e.project_id = s.project_id and e.owner_id = s.owner_id and e.archived_at is null
    where s.id = selector_secret_id
      and s.owner_id = p_owner_id
      and s.project_id = selector_project_id
      and s.environment_id = selector_environment_id
      and s.deleted_at is null;
    if not found then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, 'secret:reveal', selector_project_id, selector_environment_id, selector_secret_id, p_request_id, 'not_found');
      return jsonb_build_object('status', 'not_found');
    end if;
    if p_actor_token_id is not null and not exists (
      select 1 from notesdb.vault_agent_grants g
      where g.owner_id = p_owner_id
        and g.token_id = p_actor_token_id
        and g.project_id = selector_project_id
        and g.action = 'secret:reveal'
        and (g.environment_id is null or g.environment_id = selector_environment_id)
        and (g.secret_id is null or g.secret_id = selector_secret_id)
    ) then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, 'secret:reveal', selector_project_id, selector_environment_id, selector_secret_id, p_request_id, 'grant_denied');
      return jsonb_build_object('status', 'access_denied');
    end if;
    if not selector_secret_id = any(resolved_ids) then
      resolved_ids := array_append(resolved_ids, selector_secret_id);
      resolved_selectors := resolved_selectors || jsonb_build_array(jsonb_build_object(
        'projectId', selector_project_id,
        'environmentId', selector_environment_id,
        'secretId', selector_secret_id
      ));
    end if;
  end loop;

  return jsonb_build_object('status', 'ok', 'selectors', resolved_selectors);
end;
$$;

-- Preserve the old implementations as owner-only helpers. The public names
-- below become the only service_role-callable entry points.
alter function public.qnotes_vault_create_secret(uuid, uuid, uuid, text, text, text, uuid, text, uuid, uuid, text) rename to qnotes_vault_create_secret_legacy;
alter function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, uuid, uuid, text) rename to qnotes_vault_rotate_secret_legacy;
alter function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, text, uuid, uuid, text) rename to qnotes_vault_rotate_secret_replay_legacy;
alter function public.qnotes_vault_delete_secret(uuid, uuid, bigint, uuid, text, uuid, uuid, text) rename to qnotes_vault_delete_secret_legacy;
alter function public.qnotes_vault_reveal_secret(uuid, uuid, uuid, text, uuid, text) rename to qnotes_vault_reveal_secret_legacy;
alter function public.qnotes_vault_reveal_secrets(uuid, jsonb, uuid, text, uuid, text) rename to qnotes_vault_reveal_secrets_legacy;

revoke all on function public.qnotes_vault_create_secret_legacy(uuid, uuid, uuid, text, text, text, uuid, text, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_rotate_secret_legacy(uuid, uuid, text, text, bigint, uuid, text, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_rotate_secret_replay_legacy(uuid, uuid, text, text, bigint, uuid, text, text, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_delete_secret_legacy(uuid, uuid, bigint, uuid, text, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_reveal_secret_legacy(uuid, uuid, uuid, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_reveal_secrets_legacy(uuid, jsonb, uuid, text, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.qnotes_vault_create_secret(
  p_owner_id uuid, p_project_id uuid, p_environment_id uuid, p_name text,
  p_description text, p_value text, p_mutation_id uuid, p_request_hash text,
  p_actor_token_id uuid, p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:write', p_project_id, p_environment_id, null, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_create_secret_legacy(p_owner_id, p_project_id, p_environment_id, p_name, p_description, p_value, p_mutation_id, p_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_rotate_secret(
  p_owner_id uuid, p_secret_id uuid, p_value text, p_description text,
  p_expected_version bigint, p_mutation_id uuid, p_request_hash text,
  p_actor_token_id uuid, p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:write', null, null, p_secret_id, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_rotate_secret_legacy(p_owner_id, p_secret_id, p_value, p_description, p_expected_version, p_mutation_id, p_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_rotate_secret(
  p_owner_id uuid, p_secret_id uuid, p_value text, p_description text,
  p_expected_version bigint, p_mutation_id uuid, p_request_hash text,
  p_legacy_request_hash text, p_actor_token_id uuid, p_request_id uuid,
  p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:write', null, null, p_secret_id, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_rotate_secret_replay_legacy(p_owner_id, p_secret_id, p_value, p_description, p_expected_version, p_mutation_id, p_request_hash, p_legacy_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_delete_secret(
  p_owner_id uuid, p_secret_id uuid, p_expected_version bigint,
  p_mutation_id uuid, p_request_hash text, p_actor_token_id uuid,
  p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:delete', null, null, p_secret_id, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_delete_secret_legacy(p_owner_id, p_secret_id, p_expected_version, p_mutation_id, p_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_reveal_secret(
  p_owner_id uuid, p_secret_id uuid, p_actor_token_id uuid,
  p_purpose text, p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:reveal', null, null, p_secret_id, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_reveal_secret_legacy(p_owner_id, p_secret_id, p_actor_token_id, p_purpose, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_reveal_secrets(
  p_owner_id uuid, p_selectors jsonb, p_actor_token_id uuid,
  p_purpose text, p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  authz := public.qnotes_vault_authorize_batch(p_owner_id, p_selectors, p_actor_token_id, p_actor_kind, p_request_id);
  if authz->>'status' <> 'ok' then return authz - 'selectors'; end if;
  return public.qnotes_vault_reveal_secrets_legacy(p_owner_id, authz->'selectors', p_actor_token_id, p_purpose, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_revoke_vault_agent_token(
  p_owner_id uuid,
  p_token_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare token_row notesdb.vault_agent_tokens%rowtype;
begin
  select * into token_row
  from notesdb.vault_agent_tokens
  where id = p_token_id and owner_id = p_owner_id
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if token_row.revoked_at is null then
    update notesdb.vault_agent_tokens
    set revoked_at = timezone('utc', now())
    where id = p_token_id and owner_id = p_owner_id;
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;

alter function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb) set lock_timeout = '5s';

revoke all on function public.qnotes_vault_record_denial(uuid, uuid, text, uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_authorize_actor(uuid, uuid, text, text, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_authorize_batch(uuid, jsonb, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qnotes_vault_create_secret(uuid, uuid, uuid, text, text, text, uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_delete_secret(uuid, uuid, bigint, uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_reveal_secret(uuid, uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_reveal_secrets(uuid, jsonb, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_revoke_vault_agent_token(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qnotes_vault_create_secret(uuid, uuid, uuid, text, text, text, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, text, uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_delete_secret(uuid, uuid, bigint, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_reveal_secret(uuid, uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.qnotes_vault_reveal_secrets(uuid, jsonb, uuid, text, uuid, text) to service_role;
grant execute on function public.qnotes_revoke_vault_agent_token(uuid, uuid) to service_role;
