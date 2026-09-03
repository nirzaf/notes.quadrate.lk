# Quadrate Notes deployment

Quadrate Notes has two production parts:

- Supabase project `ciyoandzjezgqxjpcrin`: PostgreSQL, Auth, Storage, Realtime, and Edge Functions.
- Cloudflare Pages project `notes-quadrate-lk`: the Vite frontend at [notes.quadrate.lk](https://notes.quadrate.lk/).

Database migrations create application objects in the `notesdb` schema. Do not run `supabase db reset` against production.

## Requirements

- Node.js with Corepack enabled.
- A clean checkout of the repository.
- Access to the Supabase project and its database password.
- A scoped Cloudflare API token with Pages edit access, or an interactive Wrangler login.
- Production secrets available from a password manager. Never commit them or put them in Vite variables.

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
read -rsp 'QNOTES worker secret: ' QNOTES_INTERNAL_WORKER_SECRET
printf '\n'

pnpm exec supabase secrets set --project-ref ciyoandzjezgqxjpcrin \
  QNOTES_ALLOWED_ORIGIN="https://notes.quadrate.lk" \
  QNOTES_TOKEN_PEPPER="$QNOTES_TOKEN_PEPPER" \
  QNOTES_INTERNAL_WORKER_SECRET="$QNOTES_INTERNAL_WORKER_SECRET" \
  QNOTES_MAX_ATTACHMENT_BYTES="20971520" \
  QNOTES_EXPORT_MAX_BYTES="52428800"
```

Production must not set `QNOTES_FAKE_EMBEDDINGS=1`.

The pg_cron jobs created by the migrations use Supabase Vault. In the Supabase SQL Editor, create these entries once, using the same worker secret as above. If the named entries already exist, update them instead of creating duplicates:

```sql
select vault.create_secret(
  'https://ciyoandzjezgqxjpcrin.supabase.co',
  'qnotes_project_url',
  'Quadrate Notes production project URL'
);

select vault.create_secret(
  '<same value as QNOTES_INTERNAL_WORKER_SECRET>',
  'qnotes_internal_worker_secret',
  'Quadrate Notes cron worker authentication'
);
```

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

The current search hardening release includes the additive migrations through `20260903000400_release_hardening.sql`. Review them in the dry-run output before applying; the latest migration fixes pagination and embedding queue races, preserves legacy RPC wrappers on the v2 contract, adds restore dedupe conflict reporting, and keeps incompatible vectors out of semantic search.

### 3. Apply pending production migrations

```bash
pnpm exec supabase db push --linked
```

When prompted, enter the production database password from the password manager. Review the migration list before accepting. Never use `db reset` on the hosted project.

### 4. Deploy Supabase Edge Functions

```bash
pnpm exec supabase functions deploy qnotes-api embedding-worker attachment-worker \
  --project-ref ciyoandzjezgqxjpcrin \
  --no-verify-jwt \
  --use-api \
  --import-map supabase/functions/deno.json
```

The functions perform their own authentication. The worker functions additionally require the `x-qnotes-worker-secret` value supplied by the Vault cron jobs.

### 5. Build the production frontend

Keep the `VITE_*` values in the current shell or CI secret store only:

```bash
pnpm run build
```

This builds all workspace packages, builds `apps/web`, and verifies that generated Edge shared sources are synchronized.

### 6. Deploy Cloudflare Pages

Deploy the generated `apps/web/dist` directory to the existing production project and attach the exact Git commit:

```bash
npx --yes wrangler@4.128.0 pages deploy apps/web/dist \
  --project-name notes-quadrate-lk \
  --branch master \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --pretty=%s)" \
  --commit-dirty=false
```

The command returns a deployment URL. A `master` deployment is production; other branches may create preview deployments.

## Verify the release

```bash
curl -fsS https://notes.quadrate.lk/
curl -fsS https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/api/health
npx --yes wrangler@4.128.0 pages deployment list --project-name notes-quadrate-lk
git status --short --branch
git rev-parse HEAD
git rev-parse origin/master
```

Expected results:

- The website returns HTTP 200.
- The API health endpoint returns a successful JSON response.
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
