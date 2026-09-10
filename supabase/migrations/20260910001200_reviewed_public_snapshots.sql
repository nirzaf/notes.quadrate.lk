-- Public links are immutable, reviewed snapshots. Legacy live-share rows stay
-- inaccessible until explicitly replaced; their old columns are preserved.

alter table notesdb.note_shares
  add column source_version integer,
  add column source_updated_at timestamptz,
  add column source_content_hash text,
  add column snapshot_title text,
  add column snapshot_content_markdown text,
  add column classification text;

alter table notesdb.note_shares
  add constraint note_shares_snapshot_fields_check check (
    (source_version is null and source_updated_at is null and source_content_hash is null and snapshot_title is null and snapshot_content_markdown is null and classification is null)
    or (expires_at is not null and source_version > 0 and source_updated_at is not null and source_content_hash ~ '^[a-f0-9]{64}$' and snapshot_title is not null and snapshot_content_markdown is not null and classification in ('publishable', 'sensitive'))
  );

drop index if exists notesdb.note_shares_one_active_key;
create unique index note_shares_one_active_key
  on notesdb.note_shares (owner_id, note_id)
  where revoked_at is null and snapshot_content_markdown is not null;

drop function if exists public.qnotes_create_note_share(uuid, uuid, text, text, timestamptz);
create or replace function public.qnotes_create_note_share(
  p_owner_id uuid,
  p_note_id uuid,
  p_token_prefix text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_expected_version integer,
  p_snapshot_title text,
  p_snapshot_content_markdown text,
  p_source_content_hash text,
  p_classification text,
  p_confirm boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  note_row notesdb.notes%rowtype;
  share_row notesdb.note_shares%rowtype;
begin
  if p_confirm is not true then
    return jsonb_build_object('status', 'not_confirmed');
  end if;

  select * into note_row
  from notesdb.notes
  where id = p_note_id and owner_id = p_owner_id
  for update;
  if not found or note_row.deleted_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if note_row.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', note_row.version);
  end if;

  if p_expires_at is null or p_expires_at <= timezone('utc', now()) or p_expires_at > timezone('utc', now()) + interval '1 year' then
    return jsonb_build_object('status', 'invalid_expiry');
  end if;

  if p_classification is distinct from 'publishable' then
    return jsonb_build_object('status', 'sensitive');
  end if;

  if p_snapshot_title is distinct from note_row.title
     or p_snapshot_content_markdown is distinct from note_row.content_markdown
     or p_source_content_hash is distinct from encode(digest(convert_to(p_snapshot_title || E'\n' || p_snapshot_content_markdown, 'UTF8'), 'sha256'), 'hex') then
    return jsonb_build_object('status', 'invalid_snapshot');
  end if;

  update notesdb.note_shares
  set revoked_at = timezone('utc', now())
  where owner_id = p_owner_id and note_id = p_note_id and revoked_at is null and snapshot_content_markdown is not null;

  insert into notesdb.note_shares (
    owner_id, note_id, token_prefix, token_hash, expires_at,
    source_version, source_updated_at, source_content_hash,
    snapshot_title, snapshot_content_markdown, classification
  )
  values (
    p_owner_id, p_note_id, p_token_prefix, p_token_hash, p_expires_at,
    note_row.version, note_row.updated_at, p_source_content_hash,
    p_snapshot_title, p_snapshot_content_markdown, p_classification
  )
  returning * into share_row;

  return jsonb_build_object(
    'status', 'ok',
    'share', jsonb_build_object(
      'id', share_row.id,
      'noteId', share_row.note_id,
      'tokenPrefix', share_row.token_prefix,
      'expiresAt', share_row.expires_at,
      'revokedAt', share_row.revoked_at,
      'createdAt', share_row.created_at
    )
  );
end;
$$;

create or replace function public.qnotes_resolve_note_share(p_token_hash text)
returns table(title text, content_markdown text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.snapshot_title, s.snapshot_content_markdown, s.source_updated_at
  from notesdb.note_shares s
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.classification = 'publishable'
    and s.source_version is not null
    and s.source_content_hash is not null
    and s.expires_at > timezone('utc', now())
  limit 1;
$$;

revoke all on function public.qnotes_create_note_share(uuid, uuid, text, text, timestamptz, integer, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.qnotes_create_note_share(uuid, uuid, text, text, timestamptz, integer, text, text, text, text, boolean) to service_role;
revoke all on function public.qnotes_resolve_note_share(text) from public, anon, authenticated;
grant execute on function public.qnotes_resolve_note_share(text) to service_role;
