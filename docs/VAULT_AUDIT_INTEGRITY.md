# Vault audit integrity

QNotes records Vault events in `notesdb.vault_audit_events`. The event row is committed in the same database transaction as a successful secret mutation, reveal, token, grant, or approval operation, so a local audit failure rolls back the protected operation. Events contain actor and resource identifiers, the targeted agent token identifier when applicable, action, result, purpose, request ID, operation ID, policy revision, and timestamps; secret values and request payloads are never stored.

The supported audit actions are:

- `metadata:read`, `secret:reveal`, `secret:write`, `secret:delete`, and `secret:use` for Vault use.
- `token:issue`, `token:revoke`, and `grant:replace` for agent administration.
- `auth:step_up`, `approval:issue`, and `approval:consume` for human approval.
- `access:denied` and `admin:recovery` for security and maintenance events.

The table is append-only for the broker runtime. `service_role` can read events and execute the approved append, claim, acknowledge, and retry RPCs, but it cannot insert, update, delete, or truncate the table directly. A non-login `qnotes_vault_audit_maintenance` role owns the controlled retention purge function. The current Supabase project remains a shared trust zone; database administrators remain outside this runtime guarantee.

Every event is copied by an insert trigger into `notesdb.vault_audit_outbox`. The outbox payload contains only the audit fields and is claimed in bounded batches with a per-claim fencing token. An external operator-owned exporter must deliver each payload to independently controlled append-only storage, acknowledge only after durable delivery, and call the retry RPC with the active lease token and bounded error text when delivery fails. Local audit commits do not wait for that network exporter; pending rows and attempts provide the lag signal. Retention purge skips events whose export row is still unacknowledged.

Audit rows retain the stable owner UUID after account deletion because the owner foreign key is intentionally absent from this table. That UUID is pseudonymous without the deleted account record. The default retention policy is 2,555 days (seven years); only the maintenance role can purge rows whose retention has expired. Production purge, retention changes, and external export remain operator-controlled actions.

Run the local SQL suite with the isolated Supabase stack. Use `scripts/verify-vault-readiness.mjs` to verify the policy/outbox tables, controlled RPC privileges, and the explicit absence of service-role access to the purge function.
