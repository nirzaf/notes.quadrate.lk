-- US-13: durable, append-only Vault audit events with a replayable export queue.

do $$
begin
  create role qnotes_vault_audit_maintenance noinherit nologin;
exception when duplicate_object then
  null;
end
$$;

grant qnotes_vault_audit_maintenance to current_user;

create table notesdb.vault_audit_policy (
  policy_id boolean primary key default true check (policy_id),
  policy_revision text not null default 'vault-audit-v1' check (policy_revision ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  retention_days integer not null default 2555 check (retention_days between 1 and 36500),
  account_erasure_policy text not null default 'retain_pseudonymous_owner_id' check (account_erasure_policy = 'retain_pseudonymous_owner_id'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into notesdb.vault_audit_policy (policy_id)
values (true)
on conflict (policy_id) do nothing;

alter table notesdb.vault_audit_events
  drop constraint if exists vault_audit_events_owner_id_fkey,
  drop constraint if exists vault_audit_actor_kind_check,
  drop constraint if exists vault_audit_action_check;

alter table notesdb.vault_audit_events
  add column if not exists policy_revision text not null default 'vault-audit-v1',
  add column if not exists operation_id uuid,
  add column if not exists retention_expires_at timestamptz,
  add constraint vault_audit_actor_kind_check check (actor_kind in ('user_jwt', 'vault_agent', 'system')),
  add constraint vault_audit_action_check check (action in (
    'metadata:read', 'secret:reveal', 'secret:write', 'secret:delete', 'secret:use',
    'token:issue', 'token:revoke', 'grant:replace', 'auth:step_up',
    'approval:issue', 'approval:consume', 'access:denied', 'admin:recovery'
  ));

update notesdb.vault_audit_events e
set retention_expires_at = e.occurred_at + make_interval(days => p.retention_days)
from notesdb.vault_audit_policy p
where e.retention_expires_at is null and p.policy_id;

alter table notesdb.vault_audit_events
  alter column retention_expires_at set default (timezone('utc', now()) + interval '2555 days'),
  alter column retention_expires_at set not null;

create index vault_audit_retention_key on notesdb.vault_audit_events (retention_expires_at);
create index vault_audit_operation_key on notesdb.vault_audit_events (operation_id) where operation_id is not null;

create table notesdb.vault_audit_outbox (
  event_id uuid primary key references notesdb.vault_audit_events(id) on delete cascade,
  owner_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default timezone('utc', now()),
  leased_until timestamptz,
  exported_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now())
);

create index vault_audit_outbox_pending_key
  on notesdb.vault_audit_outbox (available_at, created_at)
  where exported_at is null;

alter table notesdb.vault_audit_policy enable row level security;
alter table notesdb.vault_audit_outbox enable row level security;

revoke all on table notesdb.vault_audit_events, notesdb.vault_audit_policy, notesdb.vault_audit_outbox from public, anon, authenticated, service_role;
grant select on table notesdb.vault_audit_events to service_role;

grant usage on schema public, notesdb, extensions to qnotes_vault_audit_maintenance;
grant select on table notesdb.vault_audit_policy to qnotes_vault_audit_maintenance;
grant insert on table notesdb.vault_audit_events to qnotes_vault_audit_maintenance;
grant select, insert, update, delete on table notesdb.vault_audit_outbox to qnotes_vault_audit_maintenance;
grant delete on table notesdb.vault_audit_events to qnotes_vault_audit_maintenance;

alter table notesdb.vault_audit_events owner to qnotes_vault_audit_maintenance;
alter table notesdb.vault_audit_policy owner to qnotes_vault_audit_maintenance;
alter table notesdb.vault_audit_outbox owner to qnotes_vault_audit_maintenance;

create or replace function notesdb.vault_audit_outbox_insert()
returns trigger
language plpgsql
security definer
set search_path = notesdb, pg_temp
as $$
begin
  insert into notesdb.vault_audit_outbox (event_id, owner_id, payload)
  values (
    new.id,
    new.owner_id,
    jsonb_build_object(
      'eventId', new.id,
      'ownerId', new.owner_id,
      'actorKind', new.actor_kind,
      'actorTokenId', new.actor_token_id,
      'action', new.action,
      'projectId', new.project_id,
      'environmentId', new.environment_id,
      'secretId', new.secret_id,
      'purpose', new.purpose,
      'success', new.success,
      'resultCode', new.result_code,
      'requestId', new.request_id,
      'operationId', new.operation_id,
      'policyRevision', new.policy_revision,
      'occurredAt', new.occurred_at
    )
  )
  on conflict (event_id) do nothing;
  return new;
end;
$$;

alter function notesdb.vault_audit_outbox_insert() owner to qnotes_vault_audit_maintenance;

insert into notesdb.vault_audit_outbox (event_id, owner_id, payload)
select e.id, e.owner_id, jsonb_build_object(
  'eventId', e.id,
  'ownerId', e.owner_id,
  'actorKind', e.actor_kind,
  'actorTokenId', e.actor_token_id,
  'action', e.action,
  'projectId', e.project_id,
  'environmentId', e.environment_id,
  'secretId', e.secret_id,
  'purpose', e.purpose,
  'success', e.success,
  'resultCode', e.result_code,
  'requestId', e.request_id,
  'operationId', e.operation_id,
  'policyRevision', e.policy_revision,
  'occurredAt', e.occurred_at
)
from notesdb.vault_audit_events e
on conflict (event_id) do nothing;

drop trigger if exists vault_audit_events_outbox on notesdb.vault_audit_events;
create trigger vault_audit_events_outbox
after insert on notesdb.vault_audit_events
for each row execute function notesdb.vault_audit_outbox_insert();

create or replace function notesdb.vault_audit_append_only_guard()
returns trigger
language plpgsql
security definer
set search_path = notesdb, pg_temp
as $$
begin
  if current_setting('qnotes.vault_audit_maintenance', true) is distinct from 'on' then
    raise exception 'Vault audit events are append-only';
  end if;
  return old;
end;
$$;

alter function notesdb.vault_audit_append_only_guard() owner to qnotes_vault_audit_maintenance;

drop trigger if exists vault_audit_events_append_only on notesdb.vault_audit_events;
create trigger vault_audit_events_append_only
before update or delete on notesdb.vault_audit_events
for each row execute function notesdb.vault_audit_append_only_guard();

create or replace function public.qnotes_vault_append_audit_event(
  p_owner_id uuid,
  p_actor_kind text,
  p_actor_token_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_purpose text,
  p_success boolean,
  p_result_code text,
  p_request_id uuid,
  p_operation_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  policy_row notesdb.vault_audit_policy%rowtype;
  event_id uuid;
begin
  if p_owner_id is null
    or p_actor_kind not in ('user_jwt', 'vault_agent', 'system')
    or (p_actor_kind = 'vault_agent' and p_actor_token_id is null)
    or (p_actor_kind <> 'vault_agent' and p_actor_token_id is not null)
    or p_action not in (
      'metadata:read', 'secret:reveal', 'secret:write', 'secret:delete', 'secret:use',
      'token:issue', 'token:revoke', 'grant:replace', 'auth:step_up',
      'approval:issue', 'approval:consume', 'access:denied', 'admin:recovery'
    )
    or (p_purpose is not null and (char_length(p_purpose) < 1 or char_length(p_purpose) > 200 or p_purpose ~ '[\r\n]'))
    or (p_result_code is not null and p_result_code ~ '[\r\n]') then
    raise exception 'invalid Vault audit event';
  end if;

  select * into policy_row from notesdb.vault_audit_policy where policy_id for share;
  if not found then raise exception 'Vault audit policy is unavailable'; end if;

  insert into notesdb.vault_audit_events (
    owner_id, actor_kind, actor_token_id, action, project_id, environment_id,
    secret_id, purpose, success, result_code, request_id, operation_id,
    policy_revision, retention_expires_at
  ) values (
    p_owner_id, p_actor_kind, p_actor_token_id, p_action, p_project_id, p_environment_id,
    p_secret_id, p_purpose, coalesce(p_success, false), left(p_result_code, 120),
    p_request_id, coalesce(p_operation_id, p_request_id), policy_row.policy_revision,
    clock_timestamp() + make_interval(days => policy_row.retention_days)
  ) returning id into event_id;
  return event_id;
end;
$$;

alter function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid) owner to qnotes_vault_audit_maintenance;

create or replace function public.qnotes_vault_claim_audit_outbox(p_limit integer default 50)
returns table(event_id uuid, payload jsonb, attempts integer, leased_until timestamptz)
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Vault audit outbox limit must be between 1 and 100';
  end if;
  return query
  with candidates as (
    select o.event_id
    from notesdb.vault_audit_outbox o
    where o.exported_at is null
      and o.available_at <= clock_timestamp()
      and (o.leased_until is null or o.leased_until <= clock_timestamp())
    order by o.created_at, o.event_id
    limit p_limit
    for update skip locked
  )
  update notesdb.vault_audit_outbox o
  set attempts = o.attempts + 1,
      leased_until = clock_timestamp() + interval '5 minutes',
      last_error = null
  from candidates c
  where o.event_id = c.event_id
  returning o.event_id, o.payload, o.attempts, o.leased_until;
end;
$$;

create or replace function public.qnotes_vault_ack_audit_outbox(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  update notesdb.vault_audit_outbox
  set exported_at = clock_timestamp(), leased_until = null
  where event_id = p_event_id and exported_at is null;
  return found;
end;
$$;

create or replace function public.qnotes_vault_retry_audit_outbox(p_event_id uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  update notesdb.vault_audit_outbox
  set available_at = clock_timestamp() + interval '60 seconds',
      leased_until = null,
      last_error = left(regexp_replace(coalesce(p_error, 'export_failed'), '[\r\n]', '', 'g'), 200)
  where event_id = p_event_id and exported_at is null;
  return found;
end;
$$;

create or replace function public.qnotes_vault_purge_expired_audit_events(p_before timestamptz default clock_timestamp())
returns integer
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  removed integer;
begin
  perform set_config('qnotes.vault_audit_maintenance', 'on', true);
  delete from notesdb.vault_audit_events
  where retention_expires_at <= least(coalesce(p_before, clock_timestamp()), clock_timestamp());
  get diagnostics removed = row_count;
  return removed;
end;
$$;

alter function public.qnotes_vault_claim_audit_outbox(integer) owner to qnotes_vault_audit_maintenance;
alter function public.qnotes_vault_ack_audit_outbox(uuid) owner to qnotes_vault_audit_maintenance;
alter function public.qnotes_vault_retry_audit_outbox(uuid, text) owner to qnotes_vault_audit_maintenance;
alter function public.qnotes_vault_purge_expired_audit_events(timestamptz) owner to qnotes_vault_audit_maintenance;

revoke all on function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_vault_claim_audit_outbox(integer) from public, anon, authenticated;
revoke all on function public.qnotes_vault_ack_audit_outbox(uuid) from public, anon, authenticated;
revoke all on function public.qnotes_vault_retry_audit_outbox(uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_purge_expired_audit_events(timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid) to service_role;
grant execute on function public.qnotes_vault_claim_audit_outbox(integer) to service_role;
grant execute on function public.qnotes_vault_ack_audit_outbox(uuid) to service_role;
grant execute on function public.qnotes_vault_retry_audit_outbox(uuid, text) to service_role;
grant execute on function public.qnotes_vault_purge_expired_audit_events(timestamptz) to qnotes_vault_audit_maintenance;

comment on table notesdb.vault_audit_events is 'Durable append-only Vault audit events. Account deletion retains the stable pseudonymous owner UUID until the retention policy expires.';
comment on table notesdb.vault_audit_outbox is 'Idempotent local export queue. External append-only delivery is an operator-owned worker and must acknowledge only after durable export.';
comment on function public.qnotes_vault_purge_expired_audit_events(timestamptz) is 'Maintenance-only retention purge; production deletion requires explicit operator authorization.';
