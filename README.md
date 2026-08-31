# Quadrate Notes

`notes.quadrate.lk` is a browser-first personal knowledge engine for canonical Markdown notes, copyable knowledge blocks, hybrid search, private attachments, and first-class HTTP/CLI access for AI agents.

## Local setup

The repository is a greenfield pnpm workspace. It uses the local Supabase stack only; no remote deployment is part of this build.

```bash
pnpm install --frozen-lockfile=false
pnpm exec playwright install chromium
pnpm exec supabase start
pnpm exec supabase db reset
pnpm run local:env
pnpm run seed:test-users
pnpm run sync:edge
pnpm run db:types
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm dev
```

Open `http://127.0.0.1:5173`. The local test accounts are created by `seed:test-users` and are intentionally never created in a remote project.

## Architecture

- React, Vite, TanStack Router, and TanStack Query provide the PWA shell and remote state.
- Supabase Auth handles email/password sessions.
- PostgreSQL stores Markdown canonically, derived copy blocks, search documents, attachments, and mutation records.
- Database-triggered private Realtime Broadcast sends metadata-only invalidation events on `user:<id>:notes`.
- IndexedDB stores drafts, the sync cursor, and recent authoritative snapshots. Access tokens never enter IndexedDB or the service-worker cache.
- PostgreSQL full-text search is immediate. pgvector embeddings are generated asynchronously by a pgmq-backed Edge worker, with deterministic fake embeddings for local tests.
- Private Storage holds attachment objects. Plain text, Markdown, and text-based PDFs are searchable; images are stored but explicitly marked unsupported for extraction.

## Database workflow

Migrations are split by extensions, core schema, security/storage, note transactions/realtime, queues/search, and API tokens. Generate database types only from the final local schema:

```bash
pnpm exec supabase db reset
pnpm run db:types
pnpm exec supabase test db
```

`supabase db push`, `supabase functions deploy`, and other remote-targeting commands are intentionally outside this repository’s execution workflow.

## Security

All exposed application tables use owner-based RLS. Browser clients receive only a publishable key and have direct read grants; all writes go through the service-role-only transaction RPCs in `qnotes-api`. Personal tokens are scoped, expirable, revocable, and stored as HMAC-SHA-256 hashes. The full token is returned once from `POST /api/tokens`.

Set `QNOTES_ALLOWED_ORIGIN` to an exact comma-separated allow-list. Disable Realtime “Allow public access” before any production release. Keep the token pepper, worker secret, and service-role key server-side.

## API and CLI

`qnotes-api` is a single Hono Edge Function. It exposes health, note CRUD, blocks, sync, keyword/semantic/hybrid search, private attachment flows, tokens, and Markdown/ZIP exports under `/api`.

```bash
export QNOTES_URL=http://127.0.0.1:54321/functions/v1/qnotes-api
export QNOTES_TOKEN=qnt_your_scoped_token
qnotes search "ERPNext docker" --hybrid
qnotes get erpnext-production --raw
qnotes blocks erpnext-production
qnotes block get erpnext-production production-deploy
qnotes export --workspace --output notes-backup.zip
```

The CLI uses native `fetch` only; it never connects directly to PostgreSQL. Mutation requests use optimistic versions and do not retry automatically.

## Tests

```bash
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm exec supabase test db
pnpm run test:e2e
```

Playwright uses Chromium, one worker, zero retries, and two independent browser contexts where realtime/conflict behavior needs separate devices.

## Product boundaries

Autosave-level synchronization deliberately stops short of character-level collaboration. Shared cursors, CRDTs, operational transformation, team workspaces, public publishing, native apps, image OCR, analytics, MCP integration, and a large offline write queue are excluded.
