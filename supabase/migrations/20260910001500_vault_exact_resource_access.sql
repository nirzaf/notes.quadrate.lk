-- Resolve one Vault resource in the authorization transaction. Selector
-- lookups never enumerate a parent collection or return unauthorized metadata.

create or replace function public.qnotes_vault_resolve_resource(
  p_owner_id uuid,
  p_actor_token_id uuid,
  p_actor_kind text,
  p_action text,
  p_project_id uuid,
  p_project_slug text,
  p_environment_id uuid,
  p_environment_slug text,
  p_secret_id uuid,
  p_secret_name text,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare
  project_row notesdb.vault_projects%rowtype;
  environment_row notesdb.vault_environments%rowtype;
  secret_row notesdb.vault_secrets%rowtype;
  token_row notesdb.vault_agent_tokens%rowtype;
  authz jsonb;
begin
  if p_action is null or p_action not in ('metadata:read', 'secret:reveal', 'secret:write', 'secret:delete') then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  if p_project_id is not null and p_project_slug is not null
    or p_environment_id is not null and p_environment_slug is not null
    or p_secret_id is not null and p_secret_name is not null then
    return jsonb_build_object('status', 'invalid_reference');
  end if;
  if p_secret_id is null and p_secret_name is null and p_action not in ('metadata:read', 'secret:write') then
    return jsonb_build_object('status', 'invalid_reference');
  end if;
  if p_secret_name is not null and (
    p_project_id is null and p_project_slug is null
    or p_environment_id is null and p_environment_slug is null
  ) then
    return jsonb_build_object('status', 'invalid_reference');
  end if;
  if p_project_slug is not null and (btrim(p_project_slug) = '' or lower(btrim(p_project_slug)) !~ '^[a-z0-9][a-z0-9_-]{0,79}$') then
    return jsonb_build_object('status', 'invalid_reference');
  end if;
  if p_environment_slug is not null and (btrim(p_environment_slug) = '' or lower(btrim(p_environment_slug)) !~ '^[a-z0-9][a-z0-9_-]{0,79}$') then
    return jsonb_build_object('status', 'invalid_reference');
  end if;
  if p_secret_name is not null and (btrim(p_secret_name) = '' or p_secret_name !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') then
    return jsonb_build_object('status', 'invalid_reference');
  end if;

  -- Validate agent tokens before resource lookups so missing and unauthorized
  -- selectors cannot be distinguished by a qvt caller.
  if p_actor_token_id is not null then
    if p_actor_kind <> 'vault_agent' then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'invalid_actor');
      return jsonb_build_object('status', 'access_denied');
    end if;
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

  if p_secret_id is not null then
    select * into secret_row
    from notesdb.vault_secrets
    where id = p_secret_id and owner_id = p_owner_id and deleted_at is null;
    if not found then
      if p_actor_token_id is not null then
        perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
        return jsonb_build_object('status', 'access_denied');
      end if;
      return jsonb_build_object('status', 'not_found');
    end if;
  end if;

  if p_project_id is not null then
    select * into project_row
    from notesdb.vault_projects
    where id = p_project_id and owner_id = p_owner_id and archived_at is null;
  elsif p_project_slug is not null then
    select * into project_row
    from notesdb.vault_projects
    where owner_id = p_owner_id and lower(slug) = lower(btrim(p_project_slug)) and archived_at is null;
  elsif p_secret_id is not null then
    select * into project_row
    from notesdb.vault_projects
    where id = secret_row.project_id and owner_id = p_owner_id and archived_at is null;
  elsif p_environment_id is not null then
    select * into environment_row
    from notesdb.vault_environments
    where id = p_environment_id and owner_id = p_owner_id and archived_at is null;
    if not found then
      if p_actor_token_id is not null then
        perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
        return jsonb_build_object('status', 'access_denied');
      end if;
      return jsonb_build_object('status', 'environment_not_found');
    end if;
    select * into project_row
    from notesdb.vault_projects
    where id = environment_row.project_id and owner_id = p_owner_id and archived_at is null;
  else
    return jsonb_build_object('status', 'invalid_reference');
  end if;
  if project_row.id is null then
    if p_actor_token_id is not null then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
      return jsonb_build_object('status', 'access_denied');
    end if;
    return jsonb_build_object('status', 'project_not_found');
  end if;

  if p_environment_id is not null then
    select * into environment_row
    from notesdb.vault_environments
    where id = p_environment_id and project_id = project_row.id and owner_id = p_owner_id and archived_at is null;
  elsif p_environment_slug is not null then
    select * into environment_row
    from notesdb.vault_environments
    where project_id = project_row.id and owner_id = p_owner_id and lower(slug) = lower(btrim(p_environment_slug)) and archived_at is null;
  elsif p_secret_id is not null then
    select * into environment_row
    from notesdb.vault_environments
    where id = secret_row.environment_id and project_id = project_row.id and owner_id = p_owner_id and archived_at is null;
  else
    return jsonb_build_object('status', 'invalid_reference');
  end if;
  if not found or environment_row.id is null then
    if p_actor_token_id is not null then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
      return jsonb_build_object('status', 'access_denied');
    end if;
    return jsonb_build_object('status', 'environment_not_found');
  end if;

  if p_secret_name is not null then
    select * into secret_row
    from notesdb.vault_secrets
    where owner_id = p_owner_id
      and project_id = project_row.id
      and environment_id = environment_row.id
      and lower(name) = lower(btrim(p_secret_name))
      and deleted_at is null;
    if not found then
      if p_actor_token_id is not null then
        perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
        return jsonb_build_object('status', 'access_denied');
      end if;
      return jsonb_build_object('status', 'not_found');
    end if;
  elsif p_secret_id is not null and (
    secret_row.project_id is distinct from project_row.id
    or secret_row.environment_id is distinct from environment_row.id
  ) then
    if p_actor_token_id is not null then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
      return jsonb_build_object('status', 'access_denied');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  authz := public.qnotes_vault_authorize_actor(
    p_owner_id,
    p_actor_token_id,
    p_actor_kind,
    p_action,
    project_row.id,
    environment_row.id,
    case when p_secret_id is not null or p_secret_name is not null then secret_row.id else null end,
    p_request_id
  );
  if authz->>'status' <> 'ok' then return authz; end if;

  return jsonb_build_object(
    'status', 'ok',
    'resource', jsonb_build_object(
      'projectId', project_row.id,
      'environmentId', environment_row.id,
      'secretId', case when p_secret_id is not null or p_secret_name is not null then secret_row.id else null end
    )
  );
end;
$$;

revoke all on function public.qnotes_vault_resolve_resource(uuid, uuid, text, text, uuid, text, uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.qnotes_vault_resolve_resource(uuid, uuid, text, text, uuid, text, uuid, text, uuid, text, uuid) to service_role;
