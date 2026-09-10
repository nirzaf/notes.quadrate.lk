# Vault isolation decision

**Status:** `open_residual`  
**Scope:** US-03, ordinary Notes runtime compromise  
**Decision:** Keep the current Supabase Vault deployment and record the missing
isolation boundary as an open residual risk.

## Threat and trust boundary

The threat is compromise of an ordinary QNotes runtime that processes Notes,
search, attachments, workers, or hosted MCP requests. The inventory includes
every credential injected into those runtimes, including the Supabase URL,
publishable or anonymous key, service role key, Notes token pepper, Vault token
pepper, worker secret, and any configured provider or storage credentials. This
document records credential classes and privileges; it never records secret
values.

This threat is separate from compromise of the identity provider, the Vault
host or Supabase control plane, a database administrator, or a cloud
administrator. Those authorities remain outside this application boundary and
must be addressed by their own controls.

## Current deployment evidence

The current deployment co-locates Notes and Vault in the same Supabase project
and Edge runtime trust zone:

- `supabase/functions/_shared/database.ts` creates the shared database client
  from `SUPABASE_SERVICE_ROLE_KEY`; `appDbClient` is only a schema view of that
  client.
- `qnotes-api` reads Vault metadata through that shared client and calls the
  service-only Vault RPCs through the same service client. The RPCs can read
  `vault.decrypted_secrets` under their locked-down function search path.
- `qnotes-mcp` uses the service role for its OAuth authorization-code receipt
  operation. Its hosted business profile remains Notes-only, but that use is
  still evidence that the hosted function has a privileged database credential.
- Worker and token peppers, internal worker authentication, storage access, and
  provider credentials remain runtime capabilities. Their presence or absence
  does not prove Vault isolation.

The migration and readiness gate do establish useful application controls:

- Vault metadata tables use row-level policies, and direct anonymous and
  authenticated Vault RPC execution is revoked.
- The current Vault RPC signatures are checked for existence and for
  `anon`/`authenticated` denial plus `service_role` execution.
- Secret values are excluded from the readiness output and from the Notes
  search, embedding, log, browser, share, and backup contracts.

These controls do not satisfy the isolation claim. A compromised Notes runtime
that obtains the service role key remains in the same trust zone as the Vault
RPCs and can potentially use the database privilege directly. A route name,
folder, Edge Function name, or separate client object is not runtime isolation.

## Acceptance status

US-03-AC1, direct denial of every Notes-runtime credential, is **deferred**
because the current service role is shared. US-03-AC2, a separate broker with
verified principal mapping and no secret payload through Notes processes, is
**deferred**. US-03-AC3, anonymous/authenticated denial and legacy signature
closure, is covered by the current migration and readiness checks. US-03-AC4 is
**partially satisfied**: the limitation is recorded, while separate deployment
and recovery proof remain open.

The machine-readable result from `pnpm run verify:vault` reports
`isolation.status = open_residual`. A passing readiness result therefore never
claims that the current runtime is isolated.

## Closure evidence

Close this residual only after an operator-approved design and staging proof
show all of the following:

1. Vault data and its broker run in a separately secured project or deployment.
   Notes, search, attachment workers, and hosted Notes MCP have no broker
   administrative credential, encryption authority, or role-escalation path.
2. A constrained runtime role can execute only the approved broker RPCs. A
   catalog query records function ownership, role membership, default grants,
   direct decrypted views, legacy signatures, and `SECURITY DEFINER` search
   paths.
3. A synthetic-credential negative matrix uses every Notes-runtime credential
   to test table/view reads, RPC decryption, role assumption, and forged owner
   requests. A positive broker matrix verifies issuer, subject, audience,
   expiry, and principal mapping.
4. Staging recovery evidence reconciles encrypted backup counts, IDs, versions,
   grants, and receipts without logging or exporting secret values. The
   rollback plan never restores broad Notes-runtime decryption access.

Until that evidence exists, keep the current Vault route and permission model,
do not move or revoke production secrets, and do not change the `QVAULT_URL`
prohibition to imply a separate broker. This issue does not authorize a paid
deployment, production migration, permission cutover, or production deploy.
