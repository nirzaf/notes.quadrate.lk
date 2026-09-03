# Quadrate Notes API, CLI, and MCP Adapter Guide

This guide describes the current Quadrate Notes REST API, the `qnotes` CLI, the `@qnotes/api-client` package, and the native `@qnotes/mcp-server` package.

## API base URL and authentication

The web application is at [notes.quadrate.lk](https://notes.quadrate.lk/). The production API is the `qnotes-api` Supabase Edge Function:

```text
https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api
```

For local development, the function root is:

```text
http://127.0.0.1:54321/functions/v1/qnotes-api
```

Append `/api/...` to the function root for REST requests. Do not add `/api` to `QNOTES_URL`; the CLI and JavaScript client add that prefix themselves.

All `/api` routes except `/api/health` require an `Authorization: Bearer <token>` header. The API accepts either:

- A Supabase Auth access-token JWT. This is the credential used by the browser app and has access to the signed-in owner’s data.
- A scoped personal token beginning with `qnt_`. Personal tokens are limited to their declared scopes.

The `/api/tokens` routes require a Supabase user-session JWT specifically. A personal token cannot create, list, or revoke personal tokens.

Set credentials in a shell without putting the token in a URL:

```bash
export QNOTES_URL='https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api'
export QNOTES_TOKEN='qnt_paste_the_token_here'
```

Keep personal tokens in a process environment, password manager, or secret manager. Never commit them or put them in query parameters.

## Personal tokens

Create a token in the web app:

1. Sign in to [Quadrate Notes](https://notes.quadrate.lk/).
2. Open [Personal API tokens](https://notes.quadrate.lk/settings/tokens).
3. Enter a name and select the smallest set of scopes the client needs.
4. Create the token and copy the complete `qnt_...` value immediately.

The full token is returned only once. The settings page shows only its prefix afterward. Tokens may be expirable and revocable; the web form currently creates tokens without an expiry, while the REST endpoint accepts an optional ISO `expiresAt`.

### Scopes

| Scope | Allows |
| --- | --- |
| `notes:read` | List and read notes (including soft-deleted list results when requested), list notebooks, list/read blocks, read sync changes, and export individual active notes |
| `notes:write` | Create, update, move, soft-delete, and restore notes; create notebooks |
| `search:read` | Keyword, semantic, and hybrid search |
| `attachments:read` | List attachments and create 60-second download URLs |
| `attachments:write` | Request signed uploads, finalize uploads, and delete attachments |

Workspace ZIP export requires both `notes:read` and `attachments:read`.

For a read-only text-search assistant, start with:

```text
notes:read, search:read
```

Add `attachments:read` to inspect or download attachments, and add `notes:write` only when the client must change notes or notebooks.

The token-management endpoints use a Supabase access token instead of `QNOTES_TOKEN`:

```bash
export SUPABASE_ACCESS_TOKEN='supabase_user_session_access_token'

curl -fsS -X POST \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/tokens" \
  --data '{"name":"Backup script","scopes":["notes:read","attachments:read"],"expiresAt":null}'
```

Use `GET /api/tokens` to list token metadata and `DELETE /api/tokens/:tokenId` to revoke a token. Listing returns prefixes and metadata, never full token values.

## Request and response conventions

Successful JSON responses use one envelope:

```json
{
  "data": {}
}
```

Binary note and workspace exports are the exceptions; they return the Markdown or ZIP body directly with `Content-Disposition`.

Errors use this envelope and also include the same request ID in the `x-request-id` response header:

```json
{
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "The token does not have the required scope.",
    "requestId": "...",
    "details": {}
  }
}
```

For JSON requests, send `Content-Type: application/json`. `deviceId`, `mutationId`, and `expectedVersion` are part of the optimistic-mutation protocol:

- `deviceId` and `mutationId` must be UUIDs.
- `expectedVersion` must be a positive integer and must match the note’s current version for update, move, delete, and restore operations.
- Use a new `mutationId` for every logical mutation. Retrying the exact same request with the same mutation ID is idempotent; reusing the ID for a different request returns `MUTATION_REUSE_CONFLICT`.
- A version mismatch returns HTTP `409` with `NOTE_VERSION_CONFLICT`, including the current version and note in `error.details`.

The main validation limits are:

| Input | Default / limit |
| --- | --- |
| Note title | 1–200 characters |
| Note slug | 1–80 lowercase letters, numbers, hyphens, or underscores; derived from the title when omitted on create |
| Markdown body | Up to 2,000,000 JavaScript code units |
| Tags | Up to 50 tags, each at most 64 characters; tags are trimmed, lowercased, and de-duplicated |
| Notebook name | 1–80 characters; names are unique per owner, case-insensitively |
| Search query | 1–500 characters |
| Note list | Default 50, maximum 500 |
| Sync page | Default 200, maximum 500 |
| Search page | Default 20, maximum 50 |
| Attachment list | Default 20, maximum 50 |
| Attachment upload | Default 20 MiB, configurable with `QNOTES_MAX_ATTACHMENT_BYTES` |
| Workspace ZIP | Default 50 MiB, configurable with `QNOTES_EXPORT_MAX_BYTES` |

## REST API with cURL

### Health, notebooks, and notes

Health is unauthenticated:

```bash
curl -fsS "$QNOTES_URL/api/health"
```

List notebooks. Results are ordered by creation time and then name:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notebooks"
```

Create a notebook with `notes:write`:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notebooks" \
  --data '{"name":"Operations"}'
```

List active notes. `tag` is an exact normalized tag filter:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes?limit=50&tag=operations"
```

Deleted notes are excluded by default. Include them in list results with `includeDeleted=true`:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes?includeDeleted=true&limit=500"
```

Get an active note by UUID or slug:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes/your-note-slug"
```

Note summaries contain `id`, `slug`, `title`, a plain-text `excerpt`, `tags`, `notebookId`, version, timestamps, and `deletedAt`. Full notes additionally contain `contentMarkdown` and derived `contentPlain`.

### Search

The default API mode is `auto`. It uses keyword retrieval for UUIDs, slugs, quoted phrases, and short code-like identifiers, and hybrid retrieval for natural-language questions. Explicit `keyword`, `semantic`, and `hybrid` modes remain available. Keyword search covers note metadata, note chunks, copyable blocks, and extracted attachment text. Search results are returned as document items with at most two documents per note; snippets are centered on the matching passage when possible. Semantic or hybrid search uses asynchronous 384-dimensional embeddings and may not include newly written content until the worker processes its queue.

The existing GET endpoint remains available:

```bash
curl -fsS --get \
  -H "Authorization: Bearer ***" \
  "$QNOTES_URL/api/search" \
  --data-urlencode 'q=ERPNext deployment' \
  --data 'mode=auto' \
  --data 'limit=20'
```

For agent and UI callers that need filters, use `POST /api/search`:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer ***" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/search" \
  --data '{
    "query": "rollback production ERPNext",
    "mode": "auto",
    "limit": 10,
    "maxPerNote": 2,
    "filters": {
      "notebookIds": [],
      "tags": ["operations"],
      "sourceTypes": ["note_chunk", "code_block"],
      "languages": ["bash"],
      "updatedAfter": "2026-01-01T00:00:00Z",
      "unfiled": false
    },
    "minimumRelativeScore": 0.45
  }'
```

The structured success response is `{ data: { queryId, modeUsed, degraded, degradedReason?, timing, index, items, nextCursor } }`. Each item includes `documentId`, `noteId`, `noteVersion`, a stable `qnotes://notes/{noteId}/documents/{documentId}` URI, title, heading path, source type/language, snippet, tags, notebook, updated time, match reasons, and normalized/raw scores. `index` reports the embedding model, pending/failed document counts, oldest queued age, and freshness. `nextCursor` is opaque and bound to the query, resolved mode, filters, per-note cap, and score threshold; pass it unchanged in the next POST body. `minimumRelativeScore` is a page-relative ranking threshold and is not calibrated confidence. `minimumConfidence` remains accepted as a deprecated request alias. Explicit semantic retrieval falls back to keyword results with `degraded: true` when embeddings or semantic retrieval are unavailable.

Read one exact document with bounded neighboring context:

```bash
curl -fsS --get \
  -H "Authorization: Bearer ***" \
  "$QNOTES_URL/api/search/documents/DOCUMENT_UUID/context" \
  --data 'before=1' --data 'after=1' --data 'maxTokens=1800'
```

The context response contains `noteId`, `noteVersion`, `documentId`, stable URI, title, heading path, exact bounded `content`, `previous` and `next` neighboring chunks, `updatedAt`, `sourceType`, `sourceId`, `sourceKey`, `sourceTitle`, and attachment `pageNumber` when applicable. The route enforces ownership, excludes deleted notes, and keeps neighbors within the same note source; attachment neighbors are restricted to the same attachment.

### Create, update, and organize notes

Create a note with `notes:write`. `slug`, `contentMarkdown`, `tags`, `notebookId`, and `dedupeKey` are optional; omitted values default to a derived slug, an empty body, an unfiled note, and no dedupe key:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notes" \
  --data '{
    "title": "Deployment checklist",
    "contentMarkdown": "- Check backups\n- Check health endpoint\n",
    "tags": ["operations", "deployment"],
    "notebookId": "NOTEBOOK_UUID",
    "dedupeKey": "import:deployment-checklist:1",
    "deviceId": "11111111-1111-4111-8111-111111111111",
    "mutationId": "22222222-2222-4222-8222-222222222222"
  }'
```

Update replaces the complete title, slug, and Markdown body. `tags` is optional; when omitted, the current tag list is preserved. First read the note and use its current `version`:

```bash
curl -fsS -X PATCH \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notes/NOTE_UUID" \
  --data '{
    "title": "Deployment checklist",
    "slug": "deployment-checklist",
    "contentMarkdown": "- Check backups\n- Check health endpoint\n- Confirm release\n",
    "tags": ["operations", "deployment"],
    "expectedVersion": 1,
    "deviceId": "11111111-1111-4111-8111-111111111111",
    "mutationId": "33333333-3333-4333-8333-333333333333"
  }'
```

Move a note to a notebook. The target notebook must belong to the same owner. Set `notebookId` to `null` to return the note to Unfiled:

```bash
curl -fsS -X PATCH \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notes/NOTE_UUID/notebook" \
  --data '{
    "notebookId": "NOTEBOOK_UUID",
    "expectedVersion": 2,
    "deviceId": "11111111-1111-4111-8111-111111111111",
    "mutationId": "44444444-4444-4444-8444-444444444444"
  }'
```

Soft-delete and restore notes with the same versioned mutation shape:

```bash
curl -fsS -X DELETE \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notes/NOTE_UUID" \
  --data '{"expectedVersion":3,"deviceId":"11111111-1111-4111-8111-111111111111","mutationId":"55555555-5555-4555-8555-555555555555"}'

curl -fsS -X POST \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notes/NOTE_UUID/restore" \
  --data '{"expectedVersion":4,"deviceId":"11111111-1111-4111-8111-111111111111","mutationId":"66666666-6666-4666-8666-666666666666"}'
```

### Copyable blocks

List or fetch parsed blocks by note UUID or slug:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes/your-note-slug/blocks"

curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes/your-note-slug/blocks/deploy"
```

Fenced code blocks are automatically assigned stable-looking `auto-...` block keys. Named blocks use the `:::copy{id="..." ...}` Markdown extension. Named IDs must be unique within a note; supported types are `copy`, `code`, `prompt`, `command`, `sql`, `json`, `yaml`, `env`, `url`, `quote`, and `checklist`.

### Pagination and sync

`GET /api/notes` returns up to 50 summaries by default and up to 500 with `limit`. If `nextCursor` is non-null, pass it back as the opaque `cursor` value:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes?limit=500&cursor=NEXT_CURSOR"
```

`GET /api/sync` returns lightweight note metadata changes rather than note bodies. Its default page size is 200 and maximum is 500. Persist the cursor in the calling application and continue while `hasMore` is true:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/sync?limit=200&cursor=NEXT_CURSOR"
```

Each change includes `noteId`, `slug`, `title`, `tags`, `notebookId`, `version`, `updatedAt`, and `deletedAt`. A non-null `deletedAt` means the note was soft-deleted.

### Private attachments

Supported MIME types are `text/plain`, `text/markdown`, `application/pdf`, `image/png`, `image/jpeg`, and `image/webp`. The API default upload limit is 20 MiB. Text, Markdown, and text-bearing PDFs are extracted and indexed asynchronously. Images are accepted and stored privately, but the worker reports `unsupported` with `IMAGE_OCR_UNSUPPORTED` because image OCR is not implemented.

Attachment upload is a two-step API plus one direct Storage operation:

1. Request a signed upload URL with `attachments:write`.
2. Upload the bytes directly to the private `note-attachments` bucket using the returned `path` and `token`.
3. Finalize the attachment so the processing worker queues extraction.

Request the signed upload URL:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/attachments/upload-url" \
  --data '{
    "noteId": "NOTE_UUID",
    "fileName": "runbook.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 123456
  }'
```

The response contains `{ attachment, path, token }`. Use the returned `path` and `token` with the Supabase Storage client’s `uploadToSignedUrl` operation, then finalize:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/attachments/ATTACHMENT_UUID/finalize"
```

List active attachments for a note with `GET /api/notes/:noteRef/attachments`. The attachment status moves through `pending_upload`, `queued`, `processing`, and then `ready`, `failed`, or `unsupported`. Search can return ready attachment chunks.

Create a short-lived download URL with `attachments:read`:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/attachments/ATTACHMENT_UUID"
```

The response contains `signedUrl` and `expiresInSeconds: 60`. `DELETE /api/attachments/:attachmentId` removes the object and soft-deletes its metadata.

### Exports

Export one active note as `text/markdown`:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/export/note/your-note-slug" \
  -o your-note.md
```

Export the active workspace as a ZIP. This requires both `notes:read` and `attachments:read`:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/export/workspace" \
  -o quadrate-notes-backup.zip
```

The ZIP contains `notes/<slug>.md`, `attachments/<slug>/<attachment-id>-<file-name>`, and `manifest.json`. Deleted notes and deleted attachments are excluded. The default compressed ZIP limit is 50 MiB.

## Use the `qnotes` CLI

From this repository, build the API client dependency and CLI:

```bash
pnpm install --frozen-lockfile
pnpm --filter @qnotes/api-client build
pnpm --filter @qnotes/cli build

export QNOTES_URL='https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api'
export QNOTES_TOKEN='qnt_paste_the_token_here'
```

Run the compiled CLI entrypoint through its workspace package:

```bash
pnpm --filter @qnotes/cli exec node dist/index.js search 'ERPNext deployment' --hybrid
pnpm --filter @qnotes/cli exec node dist/index.js get your-note-slug --raw
pnpm --filter @qnotes/cli exec node dist/index.js blocks your-note-slug
pnpm --filter @qnotes/cli exec node dist/index.js block get your-note-slug deploy
pnpm --filter @qnotes/cli exec node dist/index.js notebooks
pnpm --filter @qnotes/cli exec node dist/index.js notebook create 'Operations'
pnpm --filter @qnotes/cli exec node dist/index.js notebook move your-note-slug NOTEBOOK_UUID
pnpm --filter @qnotes/cli exec node dist/index.js notebook move your-note-slug unfiled
pnpm --filter @qnotes/cli exec node dist/index.js create --title 'Deployment checklist' --file ./note.md
pnpm --filter @qnotes/cli exec node dist/index.js create --title 'Runbook' --file ./note.md --notebook NOTEBOOK_UUID
pnpm --filter @qnotes/cli exec node dist/index.js capture 'Remember to rotate the staging key'
pnpm --filter @qnotes/cli exec node dist/index.js append your-note-slug 'Confirm the release'
pnpm --filter @qnotes/cli exec node dist/index.js export your-note-slug --output note.md --force
pnpm --filter @qnotes/cli exec node dist/index.js export --workspace --output backup.zip --force
```

`qnotes search` defaults to `auto`; pass `--semantic` or `--hybrid`, and `--json` for JSON output. `get --raw` prints only the Markdown body. `export` prints a note to stdout when `--output` is omitted. File output refuses to overwrite an existing file unless `--force` is present.

The CLI uses native HTTP `fetch`, never connects directly to PostgreSQL, and does not retry failed requests automatically. The full command list is available with:

```bash
pnpm --filter @qnotes/cli exec node dist/index.js --help
```

## Use the JavaScript client

`@qnotes/api-client` handles the `/api` prefix, bearer authorization, `{ data: ... }` envelopes, binary exports, abort signals for searches, and structured `QNotesHttpError` failures. `search` returns `{ items, queryId, modeUsed, degraded, timing, index, nextCursor }`; use `items` for matching documents and inspect the metadata when measuring retrieval or handling keyword fallback:

```js
import { QNotesClient } from '@qnotes/api-client';

const baseUrl = process.env.QNOTES_URL;
const token = process.env.QNOTES_TOKEN;
if (!baseUrl || !token) throw new Error('QNOTES_URL and QNOTES_TOKEN are required.');

const client = new QNotesClient({
  baseUrl,
  getAccessToken: () => token,
});

const notebooks = await client.listNotebooks();
const notes = await client.listNotes({ limit: 50, tag: 'operations' });
const response = await client.searchPost({
  query: 'ERPNext deployment',
  mode: 'auto',
  limit: 10,
  maxPerNote: 2,
  filters: {},
});
const context = response.items[0] ? await client.readNoteContext(response.items[0].documentId ?? response.items[0].id) : null;

console.log(notebooks.items);
console.log(notes.items);
console.log(response.items);
console.log(response.timing);
```

The client exposes `listNotes`, `listNotebooks`, `createNotebook`, `getNote`, `createNote`, `updateNote`, `moveNoteToNotebook`, `deleteNote`, `restoreNote`, `listBlocks`, `getBlock`, `search`, `searchPost`, `readNoteContext`, `sync`, `listAttachments`, `requestAttachmentUpload`, `finalizeAttachment`, `getAttachmentDownloadUrl`, `deleteAttachment`, `listTokens`, `createToken`, `revokeToken`, `exportNote`, and `exportWorkspace`. Export methods return the raw `Response`; attachment upload still requires uploading the bytes to Supabase Storage with the signed path/token returned by `requestAttachmentUpload`.

## Native MCP server

The repository ships `@qnotes/mcp-server`, a local stdio MCP server built on `@qnotes/api-client`. It never connects directly to PostgreSQL. Build it with:

```bash
pnpm --filter @qnotes/mcp-server build
```

The default read profile exposes only `search_notes`, `read_note_context`, and `get_block`, plus optional resources:

- `qnotes://notebooks`
- `qnotes://notes/{noteId}`
- `qnotes://notes/{noteId}/documents/{documentId}`
- `qnotes://notes/{noteId}/blocks/{blockKey}`

Use a separate write profile and token for `capture_note`, `append_note`, and `update_note`. The server generates one stable device ID per process and fresh mutation IDs internally; callers never need to put mutation IDs or tokens in tool arguments. `capture_note` accepts optional `notebookId` and `dedupeKey`, `append_note` preserves Markdown boundaries, and `update_note` preserves tags when `tags` is omitted. Updates still require the expected note version.

```yaml
mcp_servers:
  quadrate_notes_read:
    command: "node"
    args:
      - "/absolute/path/notes.quadrate.lk/packages/mcp-server/dist/index.js"
    env:
      QNOTES_URL: "${QNOTES_URL}"
      QNOTES_TOKEN: "${QNOTES_READ_TOKEN}"
    connect_timeout: 10
    timeout: 20
    supports_parallel_tool_calls: true
    tools:
      include:
        - search_notes
        - read_note_context
        - get_block
      prompts: false

  quadrate_notes_write:
    command: "node"
    args:
      - "/absolute/path/notes.quadrate.lk/packages/mcp-server/dist/index.js"
    env:
      QNOTES_URL: "${QNOTES_URL}"
      QNOTES_MCP_PROFILE: "write"
      QNOTES_WRITE_TOKEN: "${QNOTES_WRITE_TOKEN}"
    connect_timeout: 10
    timeout: 20
    supports_parallel_tool_calls: false
    tools:
      include:
        - capture_note
        - append_note
        - update_note
      prompts: false
```

Keep tokens in the MCP server process environment. Do not put them in tool arguments, URLs, or returned resource content. Browser search selection telemetry is stored locally as query/document IDs and timestamps; plaintext queries are not logged or transmitted as telemetry.

## Endpoint reference

All routes except health require a bearer credential. Personal tokens must have the listed scope; `/api/tokens` requires a Supabase user JWT even though it has no personal-token scope.

| Method | Route | Scope / credential |
| --- | --- | --- |
| `GET` | `/api/health` | None |
| `GET` | `/api/notes` | `notes:read` |
| `GET` | `/api/notes/:noteRef` | `notes:read` |
| `POST` | `/api/notes` | `notes:write` |
| `PATCH` | `/api/notes/:noteId` | `notes:write` |
| `PATCH` | `/api/notes/:noteId/notebook` | `notes:write` |
| `DELETE` | `/api/notes/:noteId` | `notes:write` |
| `POST` | `/api/notes/:noteId/restore` | `notes:write` |
| `GET` | `/api/notebooks` | `notes:read` |
| `POST` | `/api/notebooks` | `notes:write` |
| `GET` | `/api/notes/:noteRef/blocks` | `notes:read` |
| `GET` | `/api/notes/:noteRef/blocks/:blockKey` | `notes:read` |
| `GET` | `/api/search` | `search:read` |
| `POST` | `/api/search` | `search:read` |
| `GET` | `/api/search/documents/:documentId/context` | `search:read` |
| `POST` | `/api/context` | `search:read` |
| `GET` | `/api/sync` | `notes:read` |
| `GET` | `/api/notes/:noteRef/attachments` | `attachments:read` |
| `POST` | `/api/attachments/upload-url` | `attachments:write` |
| `POST` | `/api/attachments/:attachmentId/finalize` | `attachments:write` |
| `GET` | `/api/attachments/:attachmentId` | `attachments:read` |
| `DELETE` | `/api/attachments/:attachmentId` | `attachments:write` |
| `GET` | `/api/export/note/:noteRef` | `notes:read` |
| `GET` | `/api/export/workspace` | `notes:read` + `attachments:read` |
| `GET` | `/api/tokens` | Supabase user JWT |
| `POST` | `/api/tokens` | Supabase user JWT |
| `DELETE` | `/api/tokens/:tokenId` | Supabase user JWT |

## Troubleshooting and security

- `401 AUTH_REQUIRED`: the bearer header is missing or empty.
- `401 INVALID_TOKEN`: the access token or personal token is invalid, revoked, or belongs to another environment.
- `401 TOKEN_EXPIRED`: the personal token expiry has passed.
- `403 INSUFFICIENT_SCOPE`: the personal token does not include the required scope, or a token-management route was called with a personal token instead of a Supabase JWT.
- `404 NOTE_NOT_FOUND`, `NOTEBOOK_NOT_FOUND`, or `ATTACHMENT_NOT_FOUND`: the resource is missing or belongs to another owner.
- `409 NOTE_VERSION_CONFLICT`: re-read the note and retry intentionally with its current version and a new mutation ID.
- `409 NOTE_SLUG_CONFLICT`: choose a slug not used by another active note.
- `409 NOTEBOOK_NAME_CONFLICT`: choose a notebook name not used by another notebook for the owner.
- `409 MUTATION_REUSE_CONFLICT`: do not reuse a mutation ID for a different request.
- `413 ATTACHMENT_TOO_LARGE` or `EXPORT_TOO_LARGE`: reduce the payload or raise the corresponding server-side limit.
- `422 VALIDATION_ERROR`: check required fields, UUIDs, versions, Markdown, pagination values, and input limits.
- `409 ATTACHMENT_NOT_UPLOADED`: upload to the signed Storage URL before finalizing.
- `422 UNSUPPORTED_ATTACHMENT_TYPE`: use one of the supported MIME types.
- `422 DUPLICATE_BLOCK_KEY` or `INVALID_COPY_BLOCK`: fix the named/fenced Markdown block syntax and make named IDs unique within the note.
- `403 CORS_ORIGIN_DENIED`: send the request from an origin in the server’s exact `QNOTES_ALLOWED_ORIGIN` allow-list.
- `503 SEMANTIC_SEARCH_UNAVAILABLE`: embedding-backed retrieval or its database RPC failed; use `mode=keyword` temporarily or verify the embedding runtime and worker deployment. Query-embedding failures are returned as degraded keyword results instead.

Do not use the Supabase database password, service-role key, publishable key, or an Auth session token as a replacement for a personal `qnt_...` token in a script or MCP adapter. If a personal token is exposed, revoke it immediately from [Personal API tokens](https://notes.quadrate.lk/settings/tokens) and create a replacement.
