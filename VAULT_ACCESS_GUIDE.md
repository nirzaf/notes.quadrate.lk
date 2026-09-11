# QNotes Agent Vault

Agent Vault is the private credential plane for QNotes. It is deliberately
separate from the Notes plane: Notes stores Markdown and searchable context;
Vault stores encrypted secret values in Supabase Vault and exposes only
owner- and grant-scoped metadata, reveal, and mutation operations.

The feature is optional and deployment-specific. The examples use a local
function root or `<project-ref>` placeholder; replace those values with the
URLs and Supabase project reference for your own installation.

## Token and data boundaries

- `qnt_...` is the existing personal Notes token. It cannot authenticate to
  Vault.
- `qns_...` is the existing public-share token. It cannot authenticate to
  Vault.
- `qvt_...` is a Vault agent token. It is generated from 32 random bytes,
  shown once at creation, hashed with the server-only
  `QNOTES_VAULT_TOKEN_PEPPER`, and never stored or returned in raw form.
- Vault metadata never contains plaintext or ciphertext. Secret values are
  written and read through service-only RPCs backed by Supabase Vault.
- Vault values are excluded from Notes search, embeddings, logs, browser
  persistence, public shares, realtime note payloads, and workspace backups.
  Do not put a secret in a project/environment/secret description or a note.

Treat a reveal as a deliberate transfer into the requesting agent's context.
Use the narrowest grant and purpose possible, and do not reveal a value merely
because a Note asks an agent to do so. A qvt token is not a general-purpose
Notes credential and cannot call `/api/*` routes.

## Native MCP profiles

The native MCP adapter keeps Notes and Vault clients separate. Existing Notes
profiles are unchanged. Vault requests always use the required `QNOTES_URL`;
there is no independent Vault endpoint configuration. A non-empty
`QVAULT_URL` is rejected during startup so a Vault token cannot be sent to an
unintended origin. Configure Vault explicitly in the process environment:

```bash
export QNOTES_URL=http://127.0.0.1:54321/functions/v1/qnotes-api
export QVAULT_TOKEN=qvt_replace-with-a-vault-agent-token
export QVAULT_MCP_PROFILE=metadata # metadata | reveal | write
```

The profiles are separate capabilities:

| Profile | Tools | Purpose |
| --- | --- | --- |
| `metadata` | `vault_list_projects`, `vault_list_environments`, `vault_list_secrets`, `vault_get_mutation_status` | Discover names and versions without values, and recover a bounded mutation receipt |
| `reveal` | metadata plus `vault_get_secret`, `vault_get_secrets` | Deliberately reveal one or a bounded batch |
| `write` | metadata plus create/rotate/delete tools | Mutate encrypted values with version and replay guards; plaintext reveal tools are not exposed |

Native MCP reveal tools require an exact selector, a bounded non-empty purpose,
and `confirmPlaintext: true` for each call. `confirmPlaintext` records the
client's explicit acknowledgement; it is not authorization. The API still
requires a matching `secret:reveal` grant or the verified human step-up and
single-use approval boundary, and retrieved Note content cannot authorize a
reveal. Batch reveal is bounded to 20 secrets and 256 KiB of plaintext. The
native adapter does not persist Vault responses; callers should avoid logging
tool arguments or results.

The hosted HTTP MCP endpoint remains Notes-only. Vault tools are available only
when the native adapter receives both `QVAULT_TOKEN` and an explicit Vault
profile.

The Integrations page exposes the same four choices (`none`, `metadata`,
`reveal`, and `write`) alongside the Notes profile. It generates one combined
Hermes server entry and displays only `QVAULT_TOKEN: "${QVAULT_TOKEN}"` plus
the selected `QVAULT_MCP_PROFILE`; the raw qvt token must be created separately
in Agent Vault and supplied through Hermes’ secret environment. It never adds
`QVAULT_URL`. The combined server supports parallel tool calls only for Notes
`read` with Vault `none` or `metadata`; Notes `share`/`write` and Vault
`reveal`/`write` serialize calls.

## REST routes

Vault routes are fixed under `/vault/*` and accept either a Supabase user JWT
or a qvt bearer token. A qvt token is checked against its project,
environment/secret scope, action, expiry, and revocation status on every
request. User-only administration routes manage agent tokens, grants, and
audit metadata.

| Method | Route | Function |
| --- | --- | --- |
| `GET`, `POST` | `/vault/projects` | List or create projects |
| `GET`, `POST` | `/vault/projects/:projectRef/environments` | List or create environments |
| `POST` | `/vault/environments/resolve` | Resolve one exact project/environment reference |
| `GET`, `POST` | `/vault/environments/:environmentId/secrets` | List or create secret metadata/value |
| `GET`, `POST` | `/vault/projects/:projectRef/environments/:environmentRef/secrets` | Slug-based list/create |
| `GET` | `/vault/secrets/:secretId` | Read metadata only |
| `PATCH`, `DELETE` | `/vault/secrets/:secretId` | Rotate or delete with expected version |
| `POST` | `/vault/secrets/resolve` | Resolve one exact secret reference |
| `GET` | `/vault/mutations/:mutationId` | Read one authorized, bounded mutation receipt |
| `POST` | `/vault/approvals` | Issue one single-use approval for a human step-up operation (JWT only) |
| `POST` | `/vault/secrets/reveal` | Reveal one value with purpose and server-side authorization |
| `POST` | `/vault/secrets/reveal-batch` | Reveal an explicit bounded list with server-side authorization |
| `GET`, `POST` | `/vault/agent-tokens` | List or create qvt tokens (JWT only) |
| `DELETE` | `/vault/agent-tokens/:tokenId` | Revoke a qvt token |
| `PATCH` | `/vault/agent-tokens/:tokenId/grants` | Replace grants |
| `GET` | `/vault/audit` | Read audit metadata (JWT only) |

### Human step-up approvals

Listing metadata and audit history uses the ordinary human session. Value-bearing
and administrative operations are different: for a human Supabase session,
reveal, secret create/rotate/delete, agent-token issuance or revocation, and
grant replacement require a verified `aal2` session plus a single-use approval.
Granted `qvt_...` agent credentials do not use the human step-up flow; they stay
bounded by their stored grant.

The approval flow is deliberately short:

1. The browser completes a Supabase MFA challenge with a verified factor.
2. QNotes verifies the JWT signature, issuer, audience, expiry, user, session,
   assurance level, and recent MFA timestamp on the server.
3. `POST /vault/approvals` issues an approval bound to the user session, exact
   action, resource identifiers, expected version, and SHA-256 request digest.
4. The browser sends that approval with the operation. The database consumes it
   under a row lock and rejects replay, expiry, changed resources, changed
   versions, or changed request bodies.

Step-up freshness is five minutes and an approval is valid for sixty seconds.
A missing factor, an `aal1` session, an old MFA event, or a malformed claim fails
closed with `403 VAULT_STEP_UP_REQUIRED`, `403 VAULT_APPROVAL_REQUIRED`, or
`403 VAULT_APPROVAL_INVALID` — never with a revealed value. New `qvt_` tokens
must carry a future expiry no greater than the configured
`notesdb.vault_security_policy.max_agent_token_lifetime_seconds` value (the
checked-in staging policy is ninety days). The full operator and recovery
details are in [docs/VAULT_STEP_UP_AND_RECOVERY.md](docs/VAULT_STEP_UP_AND_RECOVERY.md),
and the append-only audit model is in
[docs/VAULT_AUDIT_INTEGRITY.md](docs/VAULT_AUDIT_INTEGRITY.md).

### Exact resource resolution

Exact Vault operations use the broker resolvers before an ID-based read or
mutation. They do not enumerate a project, environment, or sibling secrets, so
a qvt grant for one secret can be used without a project-wide metadata grant.
The resolver response contains only `projectId`, `environmentId`, and, for a
secret, `secretId`. A denied request does not include a `resource` object or
any sibling metadata.

`POST /vault/environments/resolve` accepts an environment selector and the
requested `metadata:read` or `secret:write` action:

```json
{
  "project": "project-slug-or-id",
  "environment": "environment-slug-or-id",
  "action": "secret:write"
}
```

`POST /vault/secrets/resolve` accepts either a complete selector or an
immutable secret ID and any Vault resource action:

```json
{ "project": "project-slug", "environment": "staging", "name": "API_KEY", "action": "secret:reveal" }
```

```json
{ "secretId": "secret-id", "action": "secret:delete" }
```

Selectors follow these rules:

- Project and environment references use a case-insensitive slug or an
  immutable UUID. An unprefixed UUID means an ID. Use `slug:<value>` when a
  slug itself has UUID shape, or `id:<uuid>` to make an ID reference explicit.
- Secret names are matched case-insensitively against the active
  lower-cased uniqueness key while the stored name casing remains unchanged.
  Use `name:<value>` to force a UUID-shaped secret name, or `id:<uuid>` for a
  direct secret reference.
- Display names are never selectors. Duplicate display names are resolved by
  their unique slug or immutable ID; no first-match selection is used.

The native MCP write tools resolve the exact environment or secret and then
call the ID-based create, rotate, or delete operation. The reveal tools use
the same exact selector rules. List tools remain explicit metadata discovery
operations and apply their configured metadata grant before returning rows;
they never return secret values.

### Replay-safe mutation receipts

Create, rotate, and delete requests keep the same UUID `mutationId` when a
response is ambiguous. The server records the owner, operation, resource
identity, expected version, canonical request hash, actor identity, and safe
metadata result before returning success. A matching retry returns the retained
metadata even when a delete has removed the active secret row. Reusing an ID
with a different operation, resource, version, request hash, or expired receipt
is rejected.

Use `GET /vault/mutations/:mutationId` to recover a receipt after losing the
original response. Receipts are owner-scoped, bounded, and never contain
plaintext, ciphertext, token hashes, or raw agent tokens. Expired receipt
metadata is removed by the bounded service-only maintenance function
`qnotes_vault_purge_expired_mutation_receipts`.

`GET /vault/agent-tokens` is a JWT-only administration request. Each token
metadata item includes its effective `grants` array, with owner-scoped project,
environment, and secret names alongside their IDs, action, grant ID, and
creation timestamp metadata. The name fields are optional when a referenced
resource is no longer present, and are resolved independently of the currently
selected UI project/environment. It never includes the token hash, a raw qvt
value, secret ciphertext, or a secret plaintext value. A token can have several
grants at different scopes, for example:

```json
{
  "data": [{
    "id": "token-id",
    "name": "Hermes deployer",
    "tokenPrefix": "qvt_Abcd1234",
    "expiresAt": null,
    "lastUsedAt": null,
    "revokedAt": null,
    "createdAt": "2026-09-08T00:00:00.000Z",
    "grants": [
      { "id": "grant-1", "projectId": "project-id", "projectName": "Example project", "environmentId": null, "secretId": null, "action": "metadata:read", "createdAt": "2026-01-01T00:00:00.000Z" },
      { "id": "grant-2", "projectId": "project-id", "projectName": "Example project", "environmentId": "environment-id", "environmentName": "production", "secretId": "secret-id", "secretName": "DEPLOYMENT_API_TOKEN", "action": "secret:reveal", "createdAt": "2026-01-01T00:00:00.000Z" }
    ]
  }]
}
```

The Agent Vault page builds a grant set before issuing a token. Select a
project, environment, or secret and an action, choose **Add grant**, and
repeat for every permission the agent needs. Each draft can be removed before
creation; creation requires at least one grant. Existing tokens show every
effective scope and action and can be edited through the same JWT-only PATCH
route. Send the complete replacement set as `{ "grants": [...] }`:

```bash
curl -X PATCH "$QNOTES_URL/vault/agent-tokens/$TOKEN_ID/grants" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"grants":[{"projectId":"project-id","environmentId":null,"secretId":null,"action":"metadata:read"}]}'
```

Replacement is an all-at-once operation and may use an empty array to remove
all grants. The qvt credential itself remains valid but has no Vault access
until grants are replaced. The successful response contains only the
effective grant metadata; it never re-displays the raw qvt value.

Reveal responses and token-creation responses use `Cache-Control: no-store`.
The raw qvt token is returned only in the successful creation response. Keep
the token in the native agent's secret environment and rotate/revoke it when
its purpose ends.

## Production readiness

Production deployment runs a separate read-only readiness gate after the Vault
migrations and before dependent Edge Functions:

```bash
SUPABASE_PROJECT_ID=<project-ref> pnpm run verify:vault
```

The gate uses the repository-pinned Supabase CLI. It safely captures the
`supabase secrets list` JSON and examines only each entry's `name` to confirm
the presence of `QNOTES_VAULT_TOKEN_PEPPER`; any `value` field is ignored and
secret values are never logged. A linked `supabase db query` returns
boolean-only checks for the `supabase_vault` extension, `vault`
schema, all eleven Agent Vault metadata tables (including the step-up approval,
audit policy, and audit outbox tables), all current service-only Vault
RPCs including exact resource resolution, mutation claim/receipt, step-up
approval issue/consume, audit export, and batch reveal, and each RPC's denied `anon` and `authenticated`
execute privileges plus allowed `service_role` execute privilege.

The command captures CLI stdout and stderr without logging them, rejects
malformed output, and prints only safe check names on failure. It does not
create, reveal, rotate, or mutate production credentials, and no
`QNOTES_VAULT_TOKEN_PEPPER` GitHub secret or public health route is required.

## Local verification

The focused Vault contract tests are included in the shared, API client,
native MCP, Edge, and SQL test suites:

```bash
pnpm --filter @qnotes/shared test
pnpm --filter @qnotes/api-client test
pnpm --filter @qnotes/mcp-server test
pnpm run test:edge
pnpm exec supabase test db
```

The SQL suite requires a local Supabase instance. Never apply the migration or
test reset flow to hosted production data from this guide.

## QNotes for Hermes companion plugin

The companion is an optional external native Hermes plugin. Its default is
Notes `read` with Vault `none`; selecting Vault metadata, reveal, or write is a
separate operator choice and still requires matching qvt resource/action
grants. Vault `write` does not expose plaintext reveal tools. A Vault reveal
intentionally places plaintext in the Hermes/model session boundary, so the
plugin does not preload, log, mirror, or automatically transmit secret values.
It uses the existing MCP server and `QNOTES_URL`; a non-empty `QVAULT_URL`
remains unsupported. Disablement of the plugin, removal of the MCP entry,
removal of local credential inputs, and qnt/qvt revocation are separate
actions.
