# QNotes deployment

QNotes has two production parts:

- Supabase project `ciyoandzjezgqxjpcrin`: PostgreSQL, Auth, Storage, Realtime, and Edge Functions.
- Cloudflare Pages project `notes-quadrate-lk`: the Vite frontend at [notes.quadrate.lk](https://notes.quadrate.lk/).

Database migrations create application objects in the `notesdb` schema. Do not run `supabase db reset` against production.

## Requirements

- Node.js with Corepack enabled.
- A clean checkout of the repository.
- Access to the Supabase project and its database password.
- A scoped Cloudflare API token with Pages edit access, or an interactive Wrangler login.
- Production secrets available from a password manager. Never commit them or put them in Vite variables.

## GitHub Actions CI/CD

The repository workflow at `.github/workflows/ci.yml` uses GitHub-hosted
`ubuntu-latest` runners. Pull requests run the core checks, local Supabase
SQL/database integration tests, the path-gated search regression job, and a
bounded Chromium browser smoke job against local Supabase. The smoke job
covers the release-critical browser surfaces without starting worker functions.
The complete Playwright E2E suite remains a local/manual command
(`pnpm run test:e2e`) and is not run by CI/CD. A push to `master` deploys only
after the browser smoke and other enabled checks pass through the GitHub
`production` environment. See
[`.github/GITHUB_ACTIONS.md`](.github/GITHUB_ACTIONS.md) for the runner model,
production secrets, and local reproduction commands.

Required deployment values are stored as secrets in the GitHub `production`
environment: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and
`CLOUDFLARE_API_TOKEN`. The Cloudflare token only needs Pages Edit access. The
Supabase database password is used only by the non-interactive migration step.
The workflow accepts `CLOUDFLARE_API_KEY` plus `CLOUDFLARE_EMAIL` as a
compatibility fallback when a scoped token is unavailable.

After applying database migrations, the production job runs
`pnpm run verify:vault` before deploying any Edge Function. The gate uses the
pinned Supabase CLI to safely capture the secrets-list JSON, examines only each
entry's `name` (checking that `QNOTES_VAULT_TOKEN_PEPPER` is present), ignores
any `value` field, and never logs secret values. It also runs a linked,
read-only boolean readiness query for the Supabase Vault extension/schema,
Agent Vault metadata tables, service-only RPCs, and their execute privileges.
`QNOTES_VAULT_TOKEN_PEPPER` is not a GitHub Actions environment secret.

The repository pins pnpm to `12.1.0`:

```bash
corepack enable
corepack install --global pnpm@12.1.0
pnpm --version
pnpm install --frozen-lockfile
```

## One-time account setup

Authenticate both CLIs and link Supabase to the intended project:

```bash
pnpm exec supabase login
pnpm exec supabase link --project-ref ciyoandzjezgqxjpcrin

npx --yes wrangler@4.128.0 login
npx --yes wrangler@4.128.0 whoami
npx --yes wrangler@4.128.0 pages project list
```

Confirm that the Pages project is `notes-quadrate-lk` before deploying. Its production branch is `master`; do not create a second Pages project.

## Production configuration

The frontend receives only these public, build-time values:

```bash
export VITE_SUPABASE_URL="https://ciyoandzjezgqxjpcrin.supabase.co"
export VITE_QNOTES_API_URL="https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api"
read -rsp 'Supabase publishable key: ' VITE_SUPABASE_PUBLISHABLE_KEY
printf '\n'
export VITE_SUPABASE_PUBLISHABLE_KEY
```

The publishable key is safe for the browser, but it is still a secret-bearing configuration value: keep it out of Git and do not use a service-role key here. The build embeds these values into `apps/web/dist`.

Set the server-only Edge Function secrets in Supabase. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Supabase Edge Functions automatically; never expose the service-role key as `VITE_*`:

```bash
read -rsp 'QNOTES token pepper: ' QNOTES_TOKEN_PEPPER
printf '\n'
read -rsp 'QNOTES Vault token pepper: ' QNOTES_VAULT_TOKEN_PEPPER
printf '\n'
read -rsp 'QNOTES worker secret: ' QNOTES_INTERNAL_WORKER_SECRET
printf '\n'

pnpm exec supabase secrets set --project-ref ciyoandzjezgqxjpcrin \
  QNOTES_ALLOWED_ORIGIN="https://notes.quadrate.lk" \
  QNOTES_TOKEN_PEPPER="$QNOTES_TOKEN_PEPPER" \
  QNOTES_VAULT_TOKEN_PEPPER="$QNOTES_VAULT_TOKEN_PEPPER" \
  QNOTES_INTERNAL_WORKER_SECRET="$QNOTES_INTERNAL_WORKER_SECRET" \
  QNOTES_MAX_ATTACHMENT_BYTES="20971520" \
  QNOTES_EXPORT_MAX_BYTES="52428800" \
  QNOTES_CLIENT_IP_HEADER="x-forwarded-for"
```

Production must not set `QNOTES_FAKE_EMBEDDINGS=1`, `QNOTES_ENVIRONMENT=test`, or `QNOTES_EMBEDDING_MODE=synthetic-test-v1`. The worker rejects a synthetic configuration before leasing queue messages. Local and staging structural tests must set all three synthetic-mode values together; a fake flag without the explicit test identity fails closed.

The Edge Functions reject request bodies before parsing them: general API
requests are capped at 8 MiB, public-share resolution at 1 KiB, Vault requests
at 278,528 bytes (256 KiB plus request overhead), and workspace imports at `QNOTES_EXPORT_MAX_BYTES` (50 MiB by
default). Shared service-only budget windows cover public sharing, OAuth,
semantic embeddings, workspace export/import, and attachment processing.
They return `429` with `Retry-After`; if the database limiter cannot be
verified, the operation fails closed with `503`. The local Supabase evidence
also records `max_rows = 1000` and Storage `file_size_limit = "50MiB"` in
`supabase/config.toml`. The production gateway must overwrite or strip the
configured `QNOTES_CLIENT_IP_HEADER` before forwarding requests; verify that
gateway behavior as deployment evidence before enabling production traffic.

The worker pg_cron jobs created by the migrations use Supabase Vault and invoke the workers every 30 seconds. A separate `qnotes-requeue-stale-embeddings` job runs daily at 03:00 UTC (06:00 UTC+03) as an embedding recovery/catch-up schedule. In the Supabase SQL Editor, create these Vault entries once, using the same worker secret as above. If the named entries already exist, update them instead of creating duplicates:

```sql
select vault.create_secret(
  'https://ciyoandzjezgqxjpcrin.supabase.co',
  'qnotes_project_url',
  'QNotes production project URL'
);

select vault.create_secret(
  '<same value as QNOTES_INTERNAL_WORKER_SECRET>',
  'qnotes_internal_worker_secret',
  'QNotes cron worker authentication'
);
```

The hosted MCP static OAuth client is fail-closed unless `QNOTES_MCP_STATIC_REDIRECT_URIS` is configured as a comma-separated list of the exact HTTPS Google/Gemini redirect URI(s) currently registered with the provider. The value is matched by an exact URI fingerprint, including path, and every entry must use one of the accepted Google redirect hosts. Do not configure only a hostname or invent a redirect path. Dynamic OAuth client registration remains available independently and continues to bind each registered redirect URI exactly.

## Release procedure

Run the following from the repository root. Database changes should be applied before deploying functions that depend on them.

### 1. Synchronize and inspect Git

```bash
git status --short --branch
git pull --ff-only origin master
git status --short --branch
git rev-parse HEAD
```

Do not deploy with unexpected local changes. Commit and push the intended release first.

### 2. Validate the workspace

```bash
pnpm run typecheck
pnpm run test:unit
pnpm exec supabase db push --linked --dry-run
```

The current release includes the additive migrations through `20260910001300_attachment_immutability.sql`. Review them in the dry-run output before applying; the latest migrations add staged attachment uploads, immutable final object paths, byte-signature and digest verification, service-only processing/deletion transitions, and retryable object cleanup. Earlier migrations add the isolated Agent Vault metadata plane, service-only RPCs, replay protections, bounded batch reveal, and unchanged pre-`expectedVersion` rotate replay compatibility alongside the caller-owned `shares:write` personal-token scope, the RLS-protected `notesdb.note_shares` table, reviewed version-bound immutable public snapshots, service-only create/rotate/revoke/resolve RPCs, automatic share revocation on note soft-delete, and a service-only single-use hosted MCP authorization-code receipt. The preceding migrations add the transaction-safe logical append receipt for the REST API, CLI, and MCP write profile, while earlier migrations fix pagination and embedding queue races, preserve legacy RPC wrappers on the v2 contract, add restore dedupe conflict reporting, keep incompatible vectors out of semantic search, and add the daily stale-embedding recovery schedule.

### 3. Apply pending production migrations

```bash
pnpm exec supabase db push --linked
```

When prompted, enter the production database password from the password manager. Review the migration list before accepting. Never use `db reset` on the hosted project.

### 4. Verify production Vault readiness

The migration must be applied before this check, and this check must pass
before any function that depends on Agent Vault is deployed:

```bash
SUPABASE_PROJECT_ID=ciyoandzjezgqxjpcrin pnpm run verify:vault
```

This is a read-only verification. The captured secrets-list output is examined
only for entry names; any secret value is ignored and never logged. The check
does not create or rotate credentials, change database state, or expose a
health route. It requires Supabase CLI authentication through the existing
`SUPABASE_ACCESS_TOKEN`; do not put `QNOTES_VAULT_TOKEN_PEPPER` in the shell,
Git, or a GitHub Actions secret for this check.

### 5. Deploy Supabase Edge Functions

```bash
pnpm exec supabase functions deploy qnotes-api embedding-worker attachment-worker qnotes-mcp \
  --project-ref ciyoandzjezgqxjpcrin \
  --no-verify-jwt \
  --use-api \
  --import-map supabase/functions/deno.json
```

The functions perform their own authentication. The worker functions additionally require the `x-qnotes-worker-secret` value supplied by the Vault cron jobs.

### 6. Build the production frontend

Keep the `VITE_*` values in the current shell or CI secret store only:

```bash
pnpm run build
```

This builds all workspace packages, builds `apps/web`, and verifies that generated Edge shared sources are synchronized.

### 7. Deploy Cloudflare Pages

Deploy the generated `apps/web/dist` directory to the existing production project and attach the exact Git commit:

```bash
npx --yes wrangler@4.128.0 pages deploy apps/web/dist \
  --project-name notes-quadrate-lk \
  --branch master \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --pretty=%s)" \
  --commit-dirty=false
```

The frontend build includes `apps/web/public/_headers`, which applies `no-store`, `no-referrer`, `noindex`, and a restrictive CSP to `/share`; keep that file in the Pages artifact. `apps/web/public/robots.txt` also disallows crawler access to `/share`. Do not deploy a public-share frontend until the matching database migration and `qnotes-api` function are available.

The command returns a deployment URL. A `master` deployment is production; other branches may create preview deployments.

## Verify the release

```bash
curl -fsS https://notes.quadrate.lk/
curl -fsS https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/api/health
curl -fsS https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-mcp/health
npx --yes wrangler@4.128.0 pages deployment list --project-name notes-quadrate-lk
git status --short --branch
git rev-parse HEAD
git rev-parse origin/master
```

Expected results:

- The website returns HTTP 200.
- The API health endpoint returns a successful JSON response.
- The remote MCP health endpoint returns `{"status":"ok"}`.
- The latest Pages deployment is `Production`, branch `master`, and shows the intended commit.
- `HEAD` matches `origin/master` and the worktree is clean.

For a feature release, also sign in at [notes.quadrate.lk](https://notes.quadrate.lk/) and exercise the changed behavior. A healthy root page alone does not verify authenticated note operations.

## Rollback

Use the Cloudflare Pages deployment list to roll back to the last known-good production deployment. If database migrations were part of the release, review their compatibility before rolling back the frontend or functions; do not reverse migrations by deleting production tables.

## Common failures

- **Frontend says configuration is missing:** rebuild with all three `VITE_*` values set in the same shell that runs `pnpm run build`.
- **API requests fail with CORS errors:** ensure `QNOTES_ALLOWED_ORIGIN` is exactly `https://notes.quadrate.lk`.
- **Workers return 401 or cron jobs do nothing:** the Edge Function `QNOTES_INTERNAL_WORKER_SECRET` and Vault `qnotes_internal_worker_secret` values must match exactly.
- **Migration history differs:** inspect the linked migration history and repository migrations before using any include-all option; do not force a reset.
- **Wrong Pages target:** run `pages project list` and verify `notes-quadrate-lk` before uploading.

## Agent Vault release notes

The additive migrations `20260907000200_agent_vault.sql`,
`20260908000100_agent_vault_batch_reveal.sql`, and
`20260909000100_agent_vault_rotate_replay_compat.sql` add the isolated Agent
Vault plane, Supabase Vault-backed service-only RPCs, qvt grants, audit, replay
receipts, bounded batch reveal, and unchanged pre-`expectedVersion` rotate
replay compatibility. Before any non-local rollout, provision the
server-only `QNOTES_VAULT_TOKEN_PEPPER` in the Edge Function environment and
run the readiness gate above. Do not put it in `VITE_*`, browser storage, Git,
or GitHub Actions secrets. This feature must not change qnt/qns Notes or
hosted-MCP behavior, and the migrations must be reviewed and applied before
frontend deployment.

## Public snapshot release notes

The `20260910001200_reviewed_public_snapshots.sql` migration adds reviewed,
version-bound immutable public snapshots and the service-only create/resolve
contract. It does not use Agent Vault or require `QNOTES_VAULT_TOKEN_PEPPER`;
review and apply it before deploying the updated API or frontend.
