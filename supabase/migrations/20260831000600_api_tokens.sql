create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_prefix text not null,
  token_hash text not null unique,
  scopes text[] not null,
  expires_at timestamptz null,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint api_tokens_scope_check check (scopes <@ array['notes:read', 'notes:write', 'search:read', 'attachments:read', 'attachments:write']::text[]),
  constraint api_tokens_scope_count_check check (cardinality(scopes) >= 1)
);
create index api_tokens_owner_created_key on public.api_tokens (owner_id, created_at desc);
alter table public.api_tokens enable row level security;
revoke all on table public.api_tokens from anon, authenticated;
create trigger api_tokens_set_updated_at before update on public.api_tokens
for each row execute function public.qnotes_set_updated_at();
