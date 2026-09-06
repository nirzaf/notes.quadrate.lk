-- Public note shares are opaque, revocable capabilities. The raw qns_ token
-- is never stored; only its peppered HMAC and a short display prefix are kept.

create table notesdb.note_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references notesdb.notes(id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  expires_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint note_shares_token_prefix_check check (token_prefix ~ '^qns_[A-Za-z0-9_-]{8}$'),
  constraint note_shares_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$')
);

create index note_shares_owner_note_created_key
  on notesdb.note_shares (owner_id, note_id, created_at desc);
create unique index note_shares_one_active_key
  on notesdb.note_shares (owner_id, note_id)
  where revoked_at is null;

alter table notesdb.note_shares enable row level security;
revoke all on table notesdb.note_shares from public, anon, authenticated;
grant all on table notesdb.note_shares to service_role;

create or replace function public.qnotes_create_note_share(
  p_owner_id uuid,
  p_note_id uuid,
  p_token_prefix text,
  p_token_hash text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  note_row notesdb.notes%rowtype;
  share_row notesdb.note_shares%rowtype;
begin
  select * into note_row
  from notesdb.notes
  where id = p_note_id and owner_id = p_owner_id
  for update;
  if not found or note_row.deleted_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expires_at is not null and (p_expires_at <= timezone('utc', now()) or p_expires_at > timezone('utc', now()) + interval '1 year') then
    return jsonb_build_object('status', 'invalid_expiry');
  end if;

  update notesdb.note_shares
  set revoked_at = timezone('utc', now())
  where owner_id = p_owner_id and note_id = p_note_id and revoked_at is null;

  insert into notesdb.note_shares (owner_id, note_id, token_prefix, token_hash, expires_at)
  values (p_owner_id, p_note_id, p_token_prefix, p_token_hash, p_expires_at)
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

create or replace function public.qnotes_revoke_note_share(
  p_owner_id uuid,
  p_note_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  note_exists boolean := false;
begin
  select true into note_exists
  from notesdb.notes
  where id = p_note_id and owner_id = p_owner_id
  for update;
  if not note_exists then
    return jsonb_build_object('status', 'not_found');
  end if;

  update notesdb.note_shares
  set revoked_at = timezone('utc', now())
  where owner_id = p_owner_id and note_id = p_note_id and revoked_at is null;
  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.qnotes_resolve_note_share(p_token_hash text)
returns table(title text, content_markdown text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select n.title, n.content_markdown, n.updated_at
  from notesdb.note_shares s
  join notesdb.notes n on n.id = s.note_id and n.owner_id = s.owner_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > timezone('utc', now()))
    and n.deleted_at is null
  limit 1;
$$;

create or replace function public.qnotes_revoke_note_share_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update notesdb.note_shares
    set revoked_at = timezone('utc', now())
    where owner_id = old.owner_id and note_id = old.id and revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists notes_revoke_share_on_delete on notesdb.notes;
create trigger notes_revoke_share_on_delete
after update of deleted_at on notesdb.notes
for each row execute function public.qnotes_revoke_note_share_on_delete();

revoke all on function public.qnotes_create_note_share(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.qnotes_create_note_share(uuid, uuid, text, text, timestamptz) to service_role;
revoke all on function public.qnotes_revoke_note_share(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qnotes_revoke_note_share(uuid, uuid) to service_role;
revoke all on function public.qnotes_resolve_note_share(text) from public, anon, authenticated;
grant execute on function public.qnotes_resolve_note_share(text) to service_role;
revoke all on function public.qnotes_revoke_note_share_on_delete() from public, anon, authenticated;
