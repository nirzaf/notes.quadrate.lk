# Quadrate Agent Vault

Agent Vault is the private credential plane for Quadrate. It is deliberately
separate from the Notes plane: Notes stores Markdown and searchable context;
Vault stores encrypted secret values in Supabase Vault and exposes only
owner- and grant-scoped metadata, reveal, and mutation operations.

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

The profiles are cumulative:

| Profile | Tools | Purpose |
| --- | --- | --- |
| `metadata` | `vault_list_projects`, `vault_list_environments`, `vault_list_secrets` | Discover names and versions without values |
| `reveal` | metadata plus `vault_get_secret`, `vault_get_secrets` | Deliberately reveal one or a bounded batch |
| `write` | reveal plus create/rotate/delete tools | Mutate encrypted values with version and replay guards |

Reveal tools require a non-empty purpose. Batch reveal is bounded to 20
secrets and 256 KiB of plaintext. The native adapter does not persist Vault
responses; callers should avoid logging tool arguments or results.

The hosted HTTP MCP endpoint remains Notes-only. Vault tools are available only
when the native adapter receives both `QVAULT_TOKEN` and an explicit Vault
profile.

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
| `GET`, `POST` | `/vault/environments/:environmentId/secrets` | List or create secret metadata/value |
| `GET`, `POST` | `/vault/projects/:projectRef/environments/:environmentRef/secrets` | Slug-based list/create |
| `GET` | `/vault/secrets/:secretId` | Read metadata only |
| `PATCH`, `DELETE` | `/vault/secrets/:secretId` | Rotate or delete with expected version |
| `POST` | `/vault/secrets/reveal` | Reveal one value with purpose |
| `POST` | `/vault/secrets/reveal-batch` | Reveal an explicit bounded list |
| `GET`, `POST` | `/vault/agent-tokens` | List or create qvt tokens (JWT only) |
| `DELETE` | `/vault/agent-tokens/:tokenId` | Revoke a qvt token |
| `PATCH` | `/vault/agent-tokens/:tokenId/grants` | Replace grants |
| `GET` | `/vault/audit` | Read audit metadata (JWT only) |

Reveal responses and token-creation responses use `Cache-Control: no-store`.
The raw qvt token is returned only in the successful creation response. Keep
the token in the native agent's secret environment and rotate/revoke it when
its purpose ends.

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
