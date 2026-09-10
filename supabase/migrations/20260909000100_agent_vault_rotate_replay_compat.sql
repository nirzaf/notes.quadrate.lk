-- Preserve retries for rotate receipts created before expectedVersion became
-- part of the request hash. New receipts continue to store p_request_hash.

create or replace function public.qnotes_vault_rotate_secret(
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

revoke all on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qnotes_vault_rotate_secret(uuid, uuid, text, text, bigint, uuid, text, text, uuid, uuid, text) to service_role;
