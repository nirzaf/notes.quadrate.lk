-- Stage 3: make the logical append operation replay-safe without embedding
-- retry markers in note Markdown. The API parses the candidate document, while
-- this RPC owns the version check, receipt, and note mutation transaction.

create or replace function public.qnotes_append_note(
  p_owner_id uuid,
  p_note_id uuid,
  p_content_markdown text,
  p_content_plain text,
  p_expected_version bigint,
  p_device_id uuid,
  p_mutation_id uuid,
  p_request_hash text,
  p_blocks jsonb,
  p_documents jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored notesdb.note_mutations%rowtype;
  note_row notesdb.notes%rowtype;
  response jsonb;
begin
  -- Fast path for ordinary retries. The second receipt check below closes the
  -- race where two identical calls arrive before the first receipt exists.
  select * into stored
  from notesdb.note_mutations
  where owner_id = p_owner_id and mutation_id = p_mutation_id
  for update;
  if found then
    if stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks');
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;

  select * into note_row
  from notesdb.notes
  where id = p_note_id and owner_id = p_owner_id
  for update;
  if not found or note_row.deleted_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- A concurrent same-operation call waits on the note row above. Re-read the
  -- receipt after that wait so it returns the committed result instead of a
  -- false stale-version conflict.
  select * into stored
  from notesdb.note_mutations
  where owner_id = p_owner_id and mutation_id = p_mutation_id
  for update;
  if found then
    if stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks');
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;

  if note_row.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', note_row.version, 'currentNote', public.qnotes_note_json(note_row));
  end if;

  update notesdb.notes
  set content_markdown = p_content_markdown,
      content_plain = p_content_plain,
      version = version + 1,
      last_mutation_id = p_mutation_id,
      updated_by_device_id = p_device_id,
      updated_at = timezone('utc', now())
  where id = p_note_id and owner_id = p_owner_id and version = p_expected_version
  returning * into note_row;

  perform public.qnotes_sync_note_content(p_note_id, p_owner_id, p_blocks, p_documents);
  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into notesdb.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'appended', p_request_hash, p_note_id, note_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

revoke all on function public.qnotes_append_note(uuid, uuid, text, text, bigint, uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qnotes_append_note(uuid, uuid, text, text, bigint, uuid, uuid, text, jsonb, jsonb) to service_role;
