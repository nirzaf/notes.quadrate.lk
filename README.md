# QNotes

QNotes is an open-source, browser-first Markdown notes workspace. It keeps
notes private by default, supports notebooks and reusable copy blocks, searches
note and attachment content, and exposes the same data through an HTTP API, a
JavaScript client, a CLI, and an MCP server.

QNotes is designed to run in your own Supabase project. The repository does not
require a QNotes-hosted account or a shared production service.

## Features

- Email/password authentication with a React/Vite progressive web app.
- Markdown editing with preview, sanitized rendering, tags, notebooks, and
  800 ms quiet-period autosave.
- Fenced and named copy blocks for commands, code, prompts, SQL, URLs, and
  other reusable content.
- Local-first search followed by API-backed keyword, semantic, or hybrid
  retrieval with notebook, tag, source, language, and date filters.
- Private attachments in Supabase Storage. Text, Markdown, and text-bearing
  PDFs are indexed asynchronously; images can be stored and previewed, but
  image OCR is not included.
- In-app screenshots for the visible area, the entire page, or a selected crop.
- Private Realtime invalidation, IndexedDB drafts, reconnect recovery, version
  checks, and a three-way conflict resolver.
- Scoped personal API tokens, revocable read-only public links that publish a
  reviewed, version-bound snapshot and reject credential-like notes, and
  version-two workspace export/import with dry-run restore checks.
- Guarded incremental editing: a bounded note outline plus preview/apply section
  patches that require an expected version and content hash, with replay-safe
  mutation receipts and status recovery.
- A native stdio MCP server with separate `read`, `share`, and `write`
  profiles.
- An optional Agent Vault plane for grant-scoped encrypted values and a native
  Hermes companion plugin.

## Repository layout

```text
apps/web/                         React/Vite PWA
packages/shared/                  shared contracts and validation
packages/markdown/                Markdown parsing, rendering, and chunking
packages/sync/                    autosave, drafts, and diff3 recovery
packages/api-client/              typed HTTP and Vault clients
packages/cli/                     qnotes command-line client
packages/mcp-server/              native stdio MCP adapter
supabase/functions/qnotes-api/    REST API and Vault routes
supabase/functions/*-worker/      embedding and attachment workers
supabase/migrations/              database schema and RLS migrations
supabase/tests/                   SQL contract tests
integrations/hermes-plugin/       optional external Hermes companion
scripts/                          local setup, generation, and verification
docs/                             hardening and Vault records
tests/e2e/                        Playwright browser tests
```

The copies under `supabase/functions/_shared/generated/` are generated from
workspace packages. After changing shared source, run `pnpm run sync:edge` and
then `pnpm run verify:edge-shared`.

## Local development

Use Node.js 18 or newer, pnpm 12.1.0, Deno 2.9.6 or newer, Docker, and the
Supabase CLI. The CI workflow currently verifies Node.js 24.19.0 and Deno
2.9.6. Python 3 is also needed for the Hermes plugin tests.

From the repository root:

```bash
corepack enable
corepack install --global pnpm@12.1.0
pnpm install --frozen-lockfile
pnpm exec supabase start
pnpm run local:env
pnpm run seed:test-users
pnpm dev
```

Open `http://127.0.0.1:5173`. `pnpm run local:env` reads the local Supabase
status without printing keys and writes ignored files for the web app, Edge
Functions, and local verification. `pnpm run seed:test-users` only accepts the
loopback Supabase target and creates the dedicated users used by browser tests.

Install the bundled browser when you need Playwright:

```bash
pnpm exec playwright install chromium
```

The local app uses the values in `.env.example` through the generated ignored
environment files. `QNOTES_FAKE_EMBEDDINGS=1` is for deterministic local tests;
do not use it for a deployment that needs real semantic search.

## Verification commands

Run the smallest check that covers your change:

```bash
pnpm run typecheck
pnpm run test:unit
pnpm run test:edge
pnpm run build
pnpm run verify:edge-shared
pnpm run test:e2e:smoke
```

After the local Supabase setup above, `pnpm run verify:local` runs the complete
local gate: typecheck, unit tests, Edge tests, build, generated-copy parity,
SQL tests, and browser smoke. It does not reset or reseed the database on its
own.

Use the focused checks for these areas:

```bash
pnpm run verify:search -- --seed
pnpm run verify:vault
pnpm exec playwright test tests/e2e/workspace-recovery.spec.ts --project=chromium
pnpm run test:plugin
git diff --check
```

Search regression is required when changing the Markdown parser, search or
embedding workers, search migrations, search fixtures/baselines, or the search
evaluation scripts. Agent Vault changes must additionally pass the SQL suite and
`pnpm run verify:vault` against a linked or local project. The recovery test
covers dry-run imports, conflicts,
private attachments, token/share exclusion, and retry identity behavior.

## API, CLI, and MCP

The API root is the Supabase function root without `/api`, for example:

```bash
export QNOTES_URL='http://127.0.0.1:54321/functions/v1/qnotes-api'
export QNOTES_TOKEN='qnt_replace-with-a-scoped-token'

pnpm --filter @qnotes/api-client build
pnpm --filter @qnotes/cli build
pnpm --filter @qnotes/cli exec node dist/index.js search 'deployment' --hybrid
pnpm --filter @qnotes/cli exec node dist/index.js get your-note-slug --raw
pnpm --filter @qnotes/cli exec node dist/index.js export --workspace --output backup.zip --force
```

The native MCP server uses the same API root and scoped token. Its default
profile is read-only:

```bash
pnpm --filter @qnotes/mcp-server build
QNOTES_URL="$QNOTES_URL" \
QNOTES_READ_TOKEN="$QNOTES_TOKEN" \
node packages/mcp-server/dist/index.js
```

Set `QNOTES_MCP_PROFILE=share` for the separate public-share profile or
`QNOTES_MCP_PROFILE=write` with `QNOTES_WRITE_TOKEN` for note mutations. Write
operations use expected versions and replay-safe mutation IDs, including the
guarded section preview/patch pair. The write
profile does not expose public-share creation unless
`QNOTES_MCP_ENABLE_PUBLIC_SHARE=true` is set and the token has `shares:write`.
Both profiles also expose `get_capabilities`, `get_note_outline`,
`list_note_changes`, and `get_mutation_status` so an agent can discover its
effective operations and recover an ambiguous write.

For REST routes, request and response contracts, JavaScript examples, CLI
commands, MCP tools, and retry rules, see
[API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md).

## Self-hosting

QNotes has three deployable parts:

1. A Supabase project for PostgreSQL, Auth, Storage, Realtime, Edge Functions,
   queues, and scheduled workers.
2. The `qnotes-api`, `embedding-worker`, `attachment-worker`, and optional
   `qnotes-mcp` Edge Functions.
3. The static `apps/web/dist` frontend, hosted by Cloudflare Pages or another
   SPA-compatible static host.

Set these frontend build values for your own project:

```bash
export VITE_SUPABASE_URL='https://<project-ref>.supabase.co'
export VITE_SUPABASE_PUBLISHABLE_KEY='replace-with-your-publishable-key'
export VITE_QNOTES_API_URL="$VITE_SUPABASE_URL/functions/v1/qnotes-api"
pnpm run build
```

Keep `SUPABASE_SERVICE_ROLE_KEY`, `QNOTES_TOKEN_PEPPER`,
`QNOTES_VAULT_TOKEN_PEPPER`, and `QNOTES_INTERNAL_WORKER_SECRET` server-side.
Set `QNOTES_ALLOWED_ORIGIN` to the exact frontend origin. Never put these
values in `VITE_*`, browser storage, Git, or a committed environment file.

The production deployment guide is a template: replace its project reference,
frontend origin, Pages project, and OAuth redirect values before use. Review
`.github/workflows/ci.yml` as well; the deploy job contains environment-specific
values that must be changed for a fork or another installation.

The hosted HTTP MCP endpoint is optional. If you enable it, configure an exact
`QNOTES_MCP_CONSENT_URL`, the allowed browser origins, and the exact Google or
Gemini redirect URIs required by your deployment. Hosted MCP intentionally
exposes the read profile by default; the explicit `share` profile only adds
24-hour public-share creation for the authenticated caller's own token.

## Security boundaries

QNotes separates credential types and data planes:

- `qnt_...` personal tokens access Notes API scopes.
- `qns_...` values are read-only public-share bearer secrets.
- `qvt_...` values access only explicitly granted Agent Vault resources.
- Vault plaintext is excluded from Notes search, embeddings, logs, browser
  persistence, public shares, and workspace backups.
- Public shares expose one saved note's title and Markdown body. They do not
  expose attachments, notebooks, or workspace metadata.
- Workspace imports are dry-run first, require explicit confirmation, reject
  conflicts, and keep attachments private.

Read [SECURITY.md](SECURITY.md) before changing repository visibility or
handling a suspected vulnerability. Read
[VAULT_ACCESS_GUIDE.md](VAULT_ACCESS_GUIDE.md) before enabling Agent Vault.

## Documentation

- [API, CLI, JavaScript, and MCP guide](API_ACCESS_GUIDE.md)
- [Fetching public notes from shared links](AI_AGENTS_SHARED_LINKS.md)
- [Agent Vault contract and profiles](VAULT_ACCESS_GUIDE.md)
- [Self-hosted deployment template](deployment.md)
- [GitHub Actions workflow and release environment](.github/GITHUB_ACTIONS.md)
- [Hermes companion plugin](integrations/hermes-plugin/README.md)
- [Hermes workflow skill](integrations/hermes-plugin/skills/workflow/SKILL.md)

## Contributing

Keep changes small and update the relevant documentation when behavior or
configuration changes. Use the pinned package manager and frozen lockfile.
Generated Edge copies must stay synchronized with their source packages. Run
the focused verification for the affected area, then `pnpm run verify:local`
when the local Supabase and Chromium prerequisites are available.

Do not include real credentials, private note content, production URLs that do
not belong to the reader, or ignored environment files in commits. Use
synthetic fixtures and placeholder values in examples.

## License

QNotes is released under the [MIT License](LICENSE).
