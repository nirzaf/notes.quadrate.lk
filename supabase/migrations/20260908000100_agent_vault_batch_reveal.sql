-- Keep Vault batch reveal service-only and transactionally all-or-nothing.

create or replace function public.qnotes_vault_reveal_secrets(
  p_owner_id uuid,
  p_selectors jsonb,
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
  selector_item jsonb;
  resolved_item jsonb;
  resolved_selectors jsonb := '[]'::jsonb;
  items jsonb := '[]'::jsonb;
  audit_rows jsonb := '[]'::jsonb;
  secret_row record;
  secret_value text;
  selector_project_id uuid;
  selector_environment_id uuid;
  selector_secret_id uuid;
  total_bytes bigint := 0;
begin
  if p_purpose is null or char_length(btrim(p_purpose)) < 1 or char_length(p_purpose) > 200 then raise exception 'invalid Vault purpose'; end if;
  if p_actor_kind is null or p_actor_kind not in ('user_jwt', 'vault_agent') then raise exception 'invalid Vault actor'; end if;
  if p_selectors is null or jsonb_typeof(p_selectors) <> 'array' then return jsonb_build_object('status', 'invalid_selectors'); end if;
  if jsonb_array_length(p_selectors) < 1 or jsonb_array_length(p_selectors) > 20 then return jsonb_build_object('status', 'invalid_selectors'); end if;

  -- Resolve and authorize the complete explicit list before touching any Vault value.
  for selector_item in select value from jsonb_array_elements(p_selectors)
  loop
    if jsonb_typeof(selector_item) <> 'object'
      or selector_item->>'projectId' is null
      or selector_item->>'environmentId' is null
      or selector_item->>'secretId' is null then
      return jsonb_build_object('status', 'invalid_selectors');
    end if;

    begin
      selector_project_id := (selector_item->>'projectId')::uuid;
      selector_environment_id := (selector_item->>'environmentId')::uuid;
      selector_secret_id := (selector_item->>'secretId')::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('status', 'invalid_selectors');
    end;
    if selector_project_id is null or selector_environment_id is null or selector_secret_id is null then
      return jsonb_build_object('status', 'invalid_selectors');
    end if;

    select s.id, s.project_id, s.environment_id, s.name, s.version, s.updated_at, s.vault_secret_id,
           p.slug as project_slug, e.slug as environment_slug
    into secret_row
    from notesdb.vault_secrets s
    join notesdb.vault_projects p on p.id = s.project_id and p.owner_id = s.owner_id
    join notesdb.vault_environments e on e.id = s.environment_id and e.project_id = s.project_id and e.owner_id = s.owner_id
    where s.id = selector_secret_id
      and s.owner_id = p_owner_id
      and s.project_id = selector_project_id
      and s.environment_id = selector_environment_id
      and p.id = selector_project_id
      and e.id = selector_environment_id
      and s.deleted_at is null
      and p.archived_at is null
      and e.archived_at is null;
    if not found then return jsonb_build_object('status', 'not_found'); end if;

    resolved_selectors := resolved_selectors || jsonb_build_array(jsonb_build_object(
      'secretId', secret_row.id,
      'project', secret_row.project_slug,
      'environment', secret_row.environment_slug,
      'name', secret_row.name,
      'version', secret_row.version,
      'updatedAt', secret_row.updated_at,
      'vaultSecretId', secret_row.vault_secret_id,
      'projectId', secret_row.project_id,
      'environmentId', secret_row.environment_id
    ));
  end loop;

  -- Decrypt and size every resolved value before inserting any success audit.
  for resolved_item in select value from jsonb_array_elements(resolved_selectors)
  loop
    select decrypted_secret
    into secret_value
    from vault.decrypted_secrets
    where id = (resolved_item->>'vaultSecretId')::uuid;
    if not found or secret_value is null then return jsonb_build_object('status', 'vault_missing'); end if;

    total_bytes := total_bytes + octet_length(secret_value);
    items := items || jsonb_build_array(jsonb_build_object(
      'secretId', resolved_item->>'secretId',
      'project', resolved_item->>'project',
      'environment', resolved_item->>'environment',
      'name', resolved_item->>'name',
      'value', secret_value,
      'version', (resolved_item->>'version')::bigint,
      'updatedAt', resolved_item->>'updatedAt'
    ));
    audit_rows := audit_rows || jsonb_build_array(jsonb_build_object(
      'projectId', resolved_item->>'projectId',
      'environmentId', resolved_item->>'environmentId',
      'secretId', resolved_item->>'secretId'
    ));
  end loop;

  if total_bytes > 262144 then return jsonb_build_object('status', 'batch_too_large'); end if;

  insert into notesdb.vault_audit_events (
    owner_id, actor_kind, actor_token_id, action, project_id, environment_id, secret_id,
    purpose, success, result_code, request_id
  )
  select p_owner_id, p_actor_kind, p_actor_token_id, 'secret:reveal',
         (audit_item->>'projectId')::uuid,
         (audit_item->>'environmentId')::uuid,
         (audit_item->>'secretId')::uuid,
         p_purpose, true, 'revealed', p_request_id
  from jsonb_array_elements(audit_rows) as audit_items(audit_item);

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;

revoke all on function public.qnotes_vault_reveal_secrets(uuid, jsonb, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.qnotes_vault_reveal_secrets(uuid, jsonb, uuid, text, uuid, text) to service_role;
