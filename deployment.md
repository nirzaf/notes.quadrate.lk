# QNotes deployment

QNotes deploys as a Supabase backend plus a static web frontend. Supabase
provides PostgreSQL, Auth, Storage, Realtime, Edge Functions, queues, and
scheduled workers. Cloudflare Pages is one supported frontend host; any
SPA-compatible static host can serve `apps/web/dist`.

This file is a self-hosting template. Replace the placeholders with values for
your own Supabase project, public web origin, and frontend host. Never copy
production IDs, domains, or secrets from another deployment.

## Requirements

- Node.js 18 or newer, Corepack, pnpm 12.1.0, and Deno 2.9.6 or newer.
- A clean checkout of the repository.
- A Supabase project, CLI login, and database password for linked migrations.
- A frontend host that supports SPA fallback. Cloudflare Pages requires a
  scoped API token or an interactive Wrangler login.
- Production secrets in a password manager or secret manager.

The repository pins pnpm:

```bash
corepack enable
corepack install --global pnpm@12.1.0
pnpm install --frozen-lockfile
```

## Configure deployment values

Set deployment-specific values in the shell that performs the release:

```bash
export SUPABASE_PROJECT_REF='<project-ref>'
export SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
export QNOTES_WEB_URL='https://your-qnotes.example'
export PAGES_PROJECT_NAME='your-pages-project'
```

The frontend build receives only public values:

```bash
export VITE_SUPABASE_URL="$SUPABASE_URL"
export VITE_QNOTES_API_URL="$SUPABASE_URL/functions/v1/qnotes-api"
read -rsp 'Supabase publishable key: ' VITE_SUPABASE_PUBLISHABLE_KEY
printf '\n'
export VITE_SUPABASE_PUBLISHABLE_KEY
```

The publishable key can be embedded in the browser build. Never use a
service-role key as a `VITE_*` value.

Set these server-only Edge Function secrets through the Supabase CLI. Use
password-manager or secret-manager input for the values; do not place them in
the repository or a shell history file:

```bash
read -rsp 'QNotes token pepper: ' QNOTES_TOKEN_PEPPER
printf '\n'
read -rsp 'QNotes Vault token pepper: ' QNOTES_VAULT_TOKEN_PEPPER
printf '\n'
read -rsp 'QNotes worker secret: ' QNOTES_INTERNAL_WORKER_SECRET
printf '\n'

pnpm exec supabase secrets set --project-ref "$SUPABASE_PROJECT_REF" \
  QNOTES_ALLOWED_ORIGIN="$QNOTES_WEB_URL" \
  QNOTES_TOKEN_PEPPER="$QNOTES_TOKEN_PEPPER" \
  QNOTES_VAULT_TOKEN_PEPPER="$QNOTES_VAULT_TOKEN_PEPPER" \
  QNOTES_INTERNAL_WORKER_SECRET="$QNOTES_INTERNAL_WORKER_SECRET" \
  QNOTES_MAX_ATTACHMENT_BYTES='20971520' \
  QNOTES_EXPORT_MAX_BYTES='52428800' \
  QNOTES_MCP_CONSENT_URL="$QNOTES_WEB_URL/oauth/authorize"
```

Do not set `QNOTES_FAKE_EMBEDDINGS=1` in production. Semantic search and the
embedding worker require the embedding runtime available to the deployment.

The worker cron jobs read the project URL and worker secret from Supabase Vault.
Create or update these entries in the SQL editor with the real values:

```sql
select vault.create_secret(
  '<supabase-project-url>',
  'qnotes_project_url',
  'QNotes project URL'
);

select vault.create_secret(
  '<same value as QNOTES_INTERNAL_WORKER_SECRET>',
  'qnotes_internal_worker_secret',
  'QNotes cron worker authentication'
);
```

If hosted MCP is enabled, set `QNOTES_MCP_ALLOWED_ORIGINS` to the exact
browser origins that may connect and set
`QNOTES_MCP_STATIC_REDIRECT_URIS` to the exact HTTPS redirect URIs registered
with the OAuth provider. Dynamic registration still binds each redirect URI
exactly. An absent or unknown `QNOTES_MCP_PROFILE` remains read-only; only the
explicit `share` value adds public-share creation.

## GitHub Actions

The workflow in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs
core, Windows Hermes launcher, integration, search-regression, and
browser-smoke jobs for pull requests and pushes. A push to `master` can then
pass through `release_gate` and the
environment-protected `deploy` job.

The deploy job is wired to the maintainer's environment-specific values. Before
enabling it in a fork, replace its Supabase project reference, frontend/API
URLs, Pages project, deployment URL, and protected GitHub environment. Store
only these deployment credentials in that environment:

- `SUPABASE_ACCESS_TOKEN`;
- `SUPABASE_DB_PASSWORD`;
- `VITE_SUPABASE_PUBLISHABLE_KEY`;
- `CLOUDFLARE_ACCOUNT_ID`;
- `CLOUDFLARE_API_TOKEN`.

The readiness gate checks the server-side
`QNOTES_VAULT_TOKEN_PEPPER` in Supabase by name. Do not add its value as a
GitHub Actions secret. See [`.github/GITHUB_ACTIONS.md`](.github/GITHUB_ACTIONS.md)
for the runner lifecycle and local reproduction commands.

## Release procedure

Run from the repository root. Apply database migrations before deploying code
that depends on them.

### 1. Synchronize and inspect Git

```bash
git status --short --branch
git pull --ff-only origin master
git status --short --branch
git rev-parse HEAD
```

Stop if the worktree contains unexpected changes.

### 2. Validate the workspace

```bash
pnpm run typecheck
pnpm run test:unit
pnpm exec supabase db push --linked --include-all --dry-run
```

Review the dry-run migration list. Use `pnpm exec supabase migration list` to
compare local and remote history when they disagree. `--include-all` is
required when a reviewed local migration was added after a later remote
version; confirm the project reference and every listed migration first. Never
use `db reset` on a hosted project.

### 3. Apply pending migrations

```bash
pnpm exec supabase db push --linked --include-all
```

Review the migration list before accepting. The current schema includes the
Notes plane, public-share records, transaction receipts, search and embedding
invariants, private attachments, and the isolated Agent Vault plane with
replay protections and bounded reveal.

### 4. Verify Agent Vault readiness

Run this after migrations and before deploying dependent functions:

```bash
SUPABASE_PROJECT_ID="$SUPABASE_PROJECT_REF" pnpm run verify:vault
```

The check is read-only. It captures the Supabase secrets-list JSON, examines
only entry names to confirm `QNOTES_VAULT_TOKEN_PEPPER`, ignores any `value`
field, and runs boolean-only database checks for the Vault extension, schema,
metadata tables, service-only RPCs, and execute privileges. It does not create,
reveal, rotate, or mutate production credentials.

### 5. Deploy Edge Functions

```bash
pnpm exec supabase functions deploy \
  qnotes-api embedding-worker attachment-worker qnotes-mcp \
  --project-ref "$SUPABASE_PROJECT_REF" \
  --no-verify-jwt \
  --use-api \
  --import-map supabase/functions/deno.json
```

The functions perform their own authentication. Worker requests additionally
require the `x-qnotes-worker-secret` value supplied by the Vault cron jobs.
Skip `qnotes-mcp` if the deployment does not provide hosted MCP.

### 6. Build the frontend

```bash
pnpm run build
```

This builds every workspace package, builds `apps/web`, and verifies that the
generated Edge copies match their source packages.

### 7. Publish the frontend

For Cloudflare Pages:

```bash
npx --yes wrangler@4.128.0 pages deploy apps/web/dist \
  --project-name "$PAGES_PROJECT_NAME" \
  --branch master \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --pretty=%s)" \
  --commit-dirty=false
```

Keep `apps/web/public/_headers`, `apps/web/public/_redirects`, and
`apps/web/public/robots.txt` in the published artifact. The share route relies
on SPA fallback and sends restrictive caching, referrer, CSP, and crawler
headers. Do not publish a public-share frontend before its migrations and API
function are available.

## Verify the release

```bash
curl --fail --silent --show-error "$QNOTES_WEB_URL/"
curl --fail --silent --show-error \
  "$SUPABASE_URL/functions/v1/qnotes-api/api/health"
curl --fail --silent --show-error \
  "$SUPABASE_URL/functions/v1/qnotes-mcp/health"
git status --short --branch
git rev-parse HEAD
git rev-parse origin/master
```

Expected results:

- the frontend returns HTTP 200;
- the API health route returns a successful JSON response;
- the MCP health route returns `{"status":"ok"}` when hosted MCP is enabled;
- `HEAD` matches `origin/master` and the worktree is clean.

Exercise the changed authenticated behavior after the route checks. A healthy
root page does not verify sign-in, note writes, attachments, search workers,
public sharing, or Vault grants.

## Rollback

Roll back the frontend to a known-good static deployment through the selected
hosting provider. Review migration compatibility before rolling back functions
or the frontend after a database migration; do not delete production tables to
reverse migration history. Re-deploy the last known-good commit when a complete
application rollback is required.

## Common failures

- **Frontend configuration is missing:** set all three `VITE_*` values in the
  same environment that runs `pnpm run build`.
- **CORS is denied:** set `QNOTES_ALLOWED_ORIGIN` to the exact frontend origin,
  including scheme and port.
- **Workers return 401 or queues stay pending:** the Edge Function worker secret
  and the `qnotes_internal_worker_secret` Vault entry must match exactly.
- **Vault readiness fails:** apply migrations first and verify that the
  server-only `QNOTES_VAULT_TOKEN_PEPPER` entry exists; never print its value.
- **Migration history differs:** inspect local and linked history before using
  an include-all option. Do not force a reset.
- **MCP OAuth fails:** set the consent URL and exact redirect URI allow-list for
  the deployment. Do not use a hostname without its registered path.
- **Wrong frontend target:** list the hosting provider's projects and confirm
  the intended project before uploading.

For the data boundaries and full-history scan, read
[SECURITY.md](SECURITY.md). For API and profile details, read
[API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md) and
[VAULT_ACCESS_GUIDE.md](VAULT_ACCESS_GUIDE.md).
