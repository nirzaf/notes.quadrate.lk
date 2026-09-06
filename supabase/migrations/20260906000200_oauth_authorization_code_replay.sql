-- OAuth authorization codes are signed for transport integrity, but their
-- redemption state must be persisted because Edge Functions are distributed.
create table notesdb.oauth_authorization_code_uses (
  code_id uuid primary key,
  expires_at timestamptz not null,
  consumed_at timestamptz not null default timezone('utc', now())
);

alter table notesdb.oauth_authorization_code_uses enable row level security;
revoke all on table notesdb.oauth_authorization_code_uses from public, anon, authenticated;
grant all on table notesdb.oauth_authorization_code_uses to service_role;

create or replace function public.qnotes_consume_oauth_authorization_code(
  p_code_id uuid,
  p_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from notesdb.oauth_authorization_code_uses
  where expires_at <= timezone('utc', now());

  if p_expires_at <= timezone('utc', now()) then
    return false;
  end if;

  insert into notesdb.oauth_authorization_code_uses (code_id, expires_at)
  values (p_code_id, p_expires_at)
  on conflict (code_id) do nothing;

  return found;
end;
$$;

revoke all on function public.qnotes_consume_oauth_authorization_code(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.qnotes_consume_oauth_authorization_code(uuid, timestamptz) to service_role;
