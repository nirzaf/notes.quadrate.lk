-- Reapply Vault actor authorization after the exact-resource resolver so
-- already deployed environments also recheck soft-deleted secrets while
-- holding the row lock.

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
    if not found or secret_row.deleted_at is not null then
      perform public.qnotes_vault_record_denial(p_owner_id, p_actor_token_id, p_action, p_project_id, p_environment_id, p_secret_id, p_request_id, 'not_found');
      if p_actor_token_id is not null then return jsonb_build_object('status', 'access_denied'); end if;
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

revoke all on function public.qnotes_vault_authorize_actor(uuid, uuid, text, text, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qnotes_vault_authorize_actor(uuid, uuid, text, text, uuid, uuid, uuid, uuid) to service_role;
