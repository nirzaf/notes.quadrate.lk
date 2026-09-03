# Quadrate Notes

`notes.quadrate.lk` is a private, browser-first Markdown notes workspace for keeping canonical notes, organizing them into notebooks, reusing copyable knowledge blocks, searching across notes and extracted attachments, and accessing the workspace through HTTP, JavaScript, or the `qnotes` CLI.

The repository is a pnpm monorepo. The web app is a Vite/React PWA, the API is a Supabase Edge Function, and the database stores Markdown as the source of truth.

## Current capabilities

- Email/password sign-in and self-service account creation through Supabase Auth.
- A Markdown editor with Edit and Preview views, 800 ms quiet-period autosave, copy-as-Markdown/plain text/rendered content, and one-click copyable blocks.
- Personal notebooks. The sidebar and home page can show All notes, Unfiled notes, or one named notebook. Notes can be moved from the note editor.
- Progressive local-first search in the web app, with recent local title/tag matches followed by server-side title/body relevance, structured notebook/tag/source/date filters, and results from copyable blocks and extracted attachment text. The API additionally supports semantic and hybrid search with opaque request-bound cursors.
- Private attachments stored in Supabase Storage. Plain text, Markdown, and text-bearing PDFs are indexed asynchronously; PNG, JPEG, and WebP files are stored but report that image OCR is unsupported.
- Versioned mutations, private Realtime Broadcast invalidation, reconnect recovery, IndexedDB draft persistence, and a conflict resolver for concurrent edits.
- Personal API tokens with least-privilege scopes for scripts, agents, backups, and the CLI.
- Note Markdown exports and workspace ZIP exports containing active notes, attachments, and a manifest.

The repository ships a native stdio MCP server in `packages/mcp-server`. See [API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md) for the REST API, CLI, JavaScript client, and MCP setup.

## Using the web app

Open `/login` to sign in or create an account. Authenticated users land on the private notes workspace at `/`.

The home page provides a paginated recent-notes view, a search field, and a notebook filter. Search shows matching recent local snapshots immediately while the API request waits for 200 ms of quiet time, then replaces them with direct ranked API result cards; a result remains navigable even when its note is outside the loaded recent-note pages. Unsupported local source/language filters wait for the server rather than showing incorrect metadata matches. Search can also be focused with `Ctrl-K` or `⌘K`. Selecting a notebook filters both the home list and the sidebar; `Unfiled` means notes whose `notebookId` is `null` and is sent as an explicit search filter. The API selects keyword, semantic, or hybrid retrieval through `auto` mode.

Use the `+` action in the Notebooks section to create a notebook. Names are trimmed, limited to 80 characters, and unique per owner. Open a note and use its notebook selector to move it to a notebook or back to Unfiled. The selector is disabled while an edit is waiting to be saved.

Inside a note, Edit opens the CodeMirror Markdown editor and Preview renders sanitized Markdown with copy buttons for fenced code and named copy blocks. The note is saved after 800 ms without changes. Delete is a soft delete that moves the note to the trash; the same note view exposes Restore for a deleted note. Export downloads the current note as `<slug>.md`.

If another device changes a note while a local draft is dirty, the conflict dialog can use the local version, use the remote version, save a manually edited merge, or cancel while retaining the local draft. If the remote note was deleted, the local draft can be saved as a new note.

## Markdown and copyable blocks

Notes accept normalized Markdown with LF line endings. Fenced code blocks are automatically indexed as copyable `code` blocks. A named block uses the following extension:

```markdown
:::copy{id="deploy" title="Deploy" lang="bash" type="command"}
docker compose up -d
:::
```

Named blocks support the `id`, `title`, `lang`, and `type` attributes. `id` is required and must be 1–64 characters matching `[a-z0-9][a-z0-9_-]*`; `title` defaults to the ID, `type` defaults to `copy`, and `lang` is optional. Supported block types are `copy`, `code`, `prompt`, `command`, `sql`, `json`, `yaml`, `env`, `url`, `quote`, and `checklist`.

Named block IDs must be unique within a note. Nested or unclosed named blocks, invalid attributes, invalid types, and unclosed fenced code blocks are rejected with `422`. Markdown HTML is disabled in the renderer. Content is limited to 2,000,000 JavaScript code units.

The parser also derives plain text and search chunks from notes. Chunks are grouped by headings and emitted with an approximate 350-token budget and 40-token overlap for asynchronous embedding work. Attachment chunks use the same token-aware overlap policy; PDF chunks retain page provenance.

## Architecture

- `apps/web` contains the authenticated React/Vite UI, CodeMirror editor, service-worker shell, notebook filters, attachment panel, token settings, and Realtime/recovery hooks.
- `packages/shared` contains shared contracts, validation, generated database types, and API error codes.
- `packages/markdown` parses and renders Markdown, derives plain text, extracts blocks, chunks content, and computes content hashes.
- `packages/sync` provides the 800 ms autosave coordinator, IndexedDB draft abstractions, and three-way merge support.
- `packages/api-client` is the typed HTTP client used by the web app and CLI. It adds `/api`, sends bearer credentials, unwraps `{ data: ... }`, and raises structured HTTP errors.
- `packages/cli` provides the `qnotes` command-line interface.
- `packages/mcp-server` provides the native read-only MCP server plus an explicit write-tool profile over `@qnotes/api-client`.
- `supabase/functions/qnotes-api` exposes the REST API. Note writes use service-role-only transaction RPCs for optimistic version checks, idempotent mutation IDs, block synchronization, and search-document updates.
- `supabase/functions/embedding-worker` consumes the `note-embeddings` queue. `supabase/functions/attachment-worker` consumes `attachment-processing`, extracts supported files, and indexes attachment chunks.
- `supabase/migrations` defines the `notesdb` schema, RLS, private Storage, pgvector/pgmq/pg_cron integration, Realtime Broadcast trigger, API tokens, notebooks, and search relevance indexes.

PostgreSQL full-text and relevance-ranked keyword search is available immediately. Embeddings are generated asynchronously in 384 dimensions with `gte-small` model version `v2`. Every vector records a hash of the exact source title, heading path, and content used to create it; model changes and stale inputs are re-queued instead of being relabeled. Local tests set `QNOTES_FAKE_EMBEDDINGS=1` for deterministic embeddings. Worker cron jobs process both queues in the configured Supabase project, with bounded concurrency and batch draining.

The browser subscribes to the private `user:<user-id>:notes` Realtime channel and receives metadata-only `note.changed` events. IndexedDB stores drafts, a notes sync cursor, and recent authoritative note snapshots. Access tokens are not stored in IndexedDB or the service-worker cache.

## Local development

Prerequisites are Node.js 18 or newer, pnpm 12.1.0, the Supabase CLI, and a browser supported by the checked-in Playwright configuration. The Playwright project targets the `chrome` channel; install or make Google Chrome available before running end-to-end tests.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm exec supabase start
pnpm exec supabase db reset
pnpm run local:env
pnpm run seed:test-users
pnpm run db:types
pnpm run sync:edge
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:mcp
```

The real search evaluator lives under `tests/search-evaluation-fixtures.json` and `scripts/evaluate-search.mjs`. Run it against a local API with `QNOTES_URL` and a scoped token; add `--seed` to create its stable dedupe-key corpus. An optional `--results` mode calculates offline metrics but is not product performance. The local-only benchmark uses `scripts/seed-search-benchmark.mjs` and `scripts/search-benchmark.mjs`; every run requires `--local-benchmark`, uses the dedicated local benchmark owner, verifies actual row counts, and reports repeated keyword/semantic/hybrid latency and ANN metadata. Query-plan collection uses `scripts/search-query-plans.sql` against a representative database.

`local:env` reads the local Supabase status without printing keys and writes ignored files at `apps/web/.env.local`, `supabase/functions/.env.test`, and `.tmp/local-env.json`. `seed:test-users` is deliberately restricted to a local Supabase URL and creates the E2E accounts used by the test suite. The test suite reads its local-only credentials from `tests/e2e/helpers.ts`; do not reuse them outside local testing.

Run the web app with:

```bash
pnpm dev
```

For manual local API calls, serve the functions in a second terminal. The web app’s generated `VITE_QNOTES_API_URL` points at this function root:

```bash
pnpm exec supabase functions serve qnotes-api embedding-worker attachment-worker \
  --env-file supabase/functions/.env.test --no-verify-jwt
```

Open `http://127.0.0.1:5173`. The local API health check is `http://127.0.0.1:54321/functions/v1/qnotes-api/api/health`.

`db:types` must run against the final local schema. After changing shared contracts or generated database types, run `pnpm run sync:edge` so the Deno functions receive the copies under `supabase/functions/_shared/generated`.

## Database, tests, and deployment

Reset the local database, regenerate types, and run SQL tests with:

```bash
pnpm exec supabase db reset
pnpm run db:types
pnpm run sync:edge
pnpm exec supabase test db
```

The unit suite covers the Markdown, sync, API-client, CLI, and MCP packages:

```bash
pnpm run test:unit
```

The E2E suite uses the single-worker, zero-retry configuration in `playwright.config.ts`. Its web-server configuration starts both Vite and the three local Edge Functions, and its global setup clears application data for the two local test users. Install the browser channel selected by the config if necessary, then run:

```bash
pnpm exec playwright install chrome
pnpm run test:e2e
```

The hosted project is `ciyoandzjezgqxjpcrin`, and the production web site is `https://notes.quadrate.lk`. Before a production deployment, set exact CORS origins and server-only secrets. Do not set `QNOTES_FAKE_EMBEDDINGS=1` in production; hosted workers need the Supabase AI runtime for `gte-small` embeddings.

Deploy the API and worker functions with the repository import map:

```bash
pnpm exec supabase functions deploy qnotes-api embedding-worker attachment-worker \
  --project-ref ciyoandzjezgqxjpcrin --no-verify-jwt --use-api \
  --import-map supabase/functions/deno.json
```

The hosted database must contain the migrations through `20260903000400_release_hardening.sql`. That release adds request-safe search functions, embedding input/version invariants, stale-vector requeueing, attachment page provenance, and safe capture deduplication. The worker cron jobs read the project URL and internal worker secret from Supabase Vault, so those Vault secrets and the Edge Function secrets must be configured before expecting asynchronous embeddings or attachment extraction.

Build and deploy the web package to Cloudflare Pages with the hosted Supabase values:

```bash
VITE_SUPABASE_URL=https://ciyoandzjezgqxjpcrin.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=... \
VITE_QNOTES_API_URL=https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api \
pnpm --filter @qnotes/web build

npx wrangler pages deploy apps/web/dist --project-name notes-quadrate-lk
```

## Security and data boundaries

Every exposed application table is protected by owner-based RLS. Browser clients receive only the Supabase publishable key and read through owner-scoped grants; writes, private attachment metadata, token operations, and search RPCs are mediated by the Edge Function and service role. Personal tokens are scoped, optionally expirable, revocable, and stored as HMAC-SHA-256 hashes. The full token is returned only from token creation.

Set `QNOTES_ALLOWED_ORIGIN` to an exact comma-separated allow-list and keep Realtime “Allow public access” disabled. Keep `QNOTES_TOKEN_PEPPER`, `QNOTES_INTERNAL_WORKER_SECRET`, and `SUPABASE_SERVICE_ROLE_KEY` server-side. Keep attachment and export limits aligned with the desired deployment; the local defaults are 20 MiB per attachment and 50 MiB per workspace ZIP.

Autosave-level synchronization deliberately stops short of character-level collaboration. Shared cursors, CRDTs, operational transformation, team workspaces, public publishing, native apps, image OCR, and a large offline write queue are outside the current product boundary.

## API and CLI quick start

Create a scoped personal token at `/settings/tokens`, then configure a client with the Edge Function root (without `/api`):

```bash
pnpm --filter @qnotes/api-client build
pnpm --filter @qnotes/cli build

export QNOTES_URL=http://127.0.0.1:54321/functions/v1/qnotes-api
export QNOTES_TOKEN=qnt_your_scoped_token

pnpm --filter @qnotes/cli exec node dist/index.js search "ERPNext docker" --hybrid
pnpm --filter @qnotes/cli exec node dist/index.js get erpnext-production --raw
pnpm --filter @qnotes/cli exec node dist/index.js blocks erpnext-production
pnpm --filter @qnotes/cli exec node dist/index.js block get erpnext-production production-deploy
pnpm --filter @qnotes/cli exec node dist/index.js notebooks
pnpm --filter @qnotes/cli exec node dist/index.js notebook create "Operations"
pnpm --filter @qnotes/cli exec node dist/index.js notebook move erpnext-production <notebook-id>
pnpm --filter @qnotes/cli exec node dist/index.js capture "Remember to rotate the staging key"
pnpm --filter @qnotes/cli exec node dist/index.js append erpnext-production "Confirm the release"
pnpm --filter @qnotes/cli exec node dist/index.js export --workspace --output notes-backup.zip --force
```

The CLI uses native `fetch`, never connects directly to PostgreSQL, and does not automatically retry failed requests. Mutation requests carry UUID `deviceId`, UUID `mutationId`, and (for updates) `expectedVersion`. For complete REST and JavaScript-client examples, read [API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md).
