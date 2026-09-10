-- US-13: update owner-only legacy Vault implementations on already-migrated databases.
-- Their audit writes must use the controlled writer introduced by US-13.

create or replace function public.qnotes_vault_create_secret_legacy(
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
    p_environment_id, secret_row.id, null, true, 'created', p_request_id, p_mutation_id, null
  );
  insert into notesdb.vault_mutations (owner_id, mutation_id, operation, request_hash, secret_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'created', p_request_hash, secret_row.id, secret_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_vault_rotate_secret_legacy(
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
    secret_row.environment_id, secret_row.id, null, true, 'rotated', p_request_id, p_mutation_id, null
  );
  insert into notesdb.vault_mutations (owner_id, mutation_id, operation, request_hash, secret_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'rotated', p_request_hash, secret_row.id, secret_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_vault_delete_secret_legacy(
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
    secret_row.environment_id, secret_row.id, null, true, 'deleted', p_request_id, p_mutation_id, null
  );
  insert into notesdb.vault_mutations (owner_id, mutation_id, operation, request_hash, secret_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'deleted', p_request_hash, secret_row.id, secret_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_vault_reveal_secret_legacy(
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

create or replace function public.qnotes_vault_reveal_secrets_legacy(
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
  audit_item jsonb;
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

  for audit_item in select value from jsonb_array_elements(audit_rows)
  loop
    perform public.qnotes_vault_append_audit_event(
      p_owner_id, p_actor_kind, p_actor_token_id, 'secret:reveal',
      (audit_item->>'projectId')::uuid,
      (audit_item->>'environmentId')::uuid,
      (audit_item->>'secretId')::uuid,
      p_purpose, true, 'revealed', p_request_id, p_request_id, null
    );
  end loop;

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;

create or replace function public.qnotes_vault_rotate_secret_replay_legacy(
  p_owner_id uuid,
  p_secret_id uuid,
  p_value text,
  p_description text,
  p_expected_version bigint,
  p_mutation_id uuid,
  p_request_hash text,
  p_legacy_request_hash text,
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
    if stored.operation = 'rotated' and p_expected_version = stored.resulting_version - 1 then
      if stored.request_hash = p_request_hash then
        return jsonb_build_object('status', 'idempotent') || stored.response;
      end if;
      if p_legacy_request_hash is not null and stored.request_hash = p_legacy_request_hash then
        return jsonb_build_object('status', 'idempotent') || stored.response;
      end if;
    end if;
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
    secret_row.environment_id, secret_row.id, null, true, 'rotated', p_request_id, p_mutation_id, null
  );
  insert into notesdb.vault_mutations (owner_id, mutation_id, operation, request_hash, secret_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'rotated', p_request_hash, secret_row.id, secret_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;
