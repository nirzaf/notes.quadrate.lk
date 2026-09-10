-- Keep request budgets shared across Edge Function instances.

create table notesdb.request_budget_windows (
  bucket text not null,
  principal_hash text not null,
  window_started timestamptz not null,
  request_count integer not null default 0,
  primary key (bucket, principal_hash, window_started),
  constraint request_budget_bucket_check check (bucket in (
    'public-share', 'oauth', 'embedding', 'workspace-export',
    'workspace-import', 'attachment-processing'
  )),
  constraint request_budget_principal_hash_check check (principal_hash ~ '^[a-f0-9]{64}$'),
  constraint request_budget_count_check check (request_count >= 0)
);

alter table notesdb.request_budget_windows enable row level security;
revoke all on table notesdb.request_budget_windows from public, anon, authenticated;
grant all on table notesdb.request_budget_windows to service_role;

create index request_budget_windows_started_key
  on notesdb.request_budget_windows (window_started);

create or replace function public.qnotes_consume_request_budget(
  p_bucket text,
  p_principal_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_cost integer default 1
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  request_count integer
)
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  current_window timestamptz;
  current_count integer;
  seconds_remaining integer;
begin
  if p_bucket is null or p_bucket not in (
    'public-share', 'oauth', 'embedding', 'workspace-export',
    'workspace-import', 'attachment-processing'
  ) then
    raise exception 'bucket is invalid';
  end if;
  if p_principal_hash is null or p_principal_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'principal hash is invalid';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'limit is invalid';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'window is invalid';
  end if;
  if p_cost is null or p_cost < 1 or p_cost > 1000 then
    raise exception 'cost is invalid';
  end if;

  current_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  delete from notesdb.request_budget_windows
  where window_started < current_window - make_interval(secs => p_window_seconds * 2);

  insert into notesdb.request_budget_windows as budget (
    bucket, principal_hash, window_started, request_count
  ) values (
    p_bucket, p_principal_hash, current_window, p_cost
  )
  on conflict on constraint request_budget_windows_pkey do update
  set request_count = least(budget.request_count + excluded.request_count, p_limit + p_cost)
  returning budget.request_count into current_count;

  allowed := current_count <= p_limit;
  seconds_remaining := greatest(
    1,
    ceil(extract(epoch from (
      current_window + make_interval(secs => p_window_seconds) - clock_timestamp()
    )))::integer
  );
  retry_after_seconds := case when allowed then 0 else seconds_remaining end;
  request_count := current_count;
  return next;
end;
$$;

revoke all on function public.qnotes_consume_request_budget(text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.qnotes_consume_request_budget(text, text, integer, integer, integer) to service_role;
