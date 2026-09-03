# Quadrate Notes API and MCP Access

This guide explains how to use a Quadrate Notes personal token with the REST API, the `qnotes` CLI, or an MCP adapter.

## Supported endpoints

The web application is at [notes.quadrate.lk](https://notes.quadrate.lk/). The production REST API is the Supabase Edge Function:

```text
https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api
```

Call API routes by appending `/api/...` to that URL. Do not add `/api` to `QNOTES_URL`; the CLI and the JavaScript client add it themselves.

## 1. Create a personal token

1. Sign in to [Quadrate Notes](https://notes.quadrate.lk/).
2. Open [Personal API tokens](https://notes.quadrate.lk/settings/tokens).
3. Enter a name such as `Read-only assistant` or `Backup script`.
4. Select the smallest set of scopes that the client needs.
5. Create the token and copy the complete `qnt_...` value immediately.

The complete token is displayed only once. Later, the settings page shows only its prefix. Store it in a password manager or a secret manager, never in a note, source file, URL, or committed `.env` file.

Creating or revoking tokens in `/api/tokens` requires the signed-in Supabase user session. A personal `qnt_...` token cannot create another personal token; use the settings page for token management.

### Scopes

| Scope | Allows |
| --- | --- |
| `notes:read` | List and read notes, notebooks, blocks, sync changes, and Markdown note exports |
| `notes:write` | Create, update, move, delete, and restore notes; create notebooks |
| `search:read` | Keyword, semantic, and hybrid note search |
| `attachments:read` | List attachments and create short-lived download URLs |
| `attachments:write` | Request uploads, finalize uploads, and delete attachments |

Workspace ZIP export requires both `notes:read` and `attachments:read`.

For a read-only assistant, start with:

```text
notes:read, search:read
```

Add `notes:write` only when the client must change notes or notebooks.

## 2. Set the token for a client

The API expects the token in the standard HTTP header:

```http
Authorization: Bearer qnt_your_token_here
```

For local shell use:

```bash
export QNOTES_URL='https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api'
export QNOTES_TOKEN='qnt_paste_the_token_here'
```

Keep the token in the process environment or a secret manager. Do not put it in a query string or commit it to Git.

## 3. Use the REST API with cURL

Health does not require authentication:

```bash
curl -fsS "$QNOTES_URL/api/health"
```

List notebooks:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notebooks"
```

List active notes:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes?limit=50"
```

Get a note by UUID or slug:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes/your-note-slug"
```

Search notes. The default is keyword search; `semantic` and `hybrid` are also supported:

```bash
curl -fsS --get \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/search" \
  --data-urlencode 'q=ERPNext deployment' \
  --data 'mode=keyword' \
  --data 'limit=20'
```

Successful JSON responses use this envelope:

```json
{"data": ...}
```

Errors use this envelope:

```json
{
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "The token does not have the required scope.",
    "requestId": "..."
  }
}
```

### Create a notebook

Requires `notes:write`:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notebooks" \
  --data '{"name":"Operations"}'
```

### Create a note

Requires `notes:write`. `deviceId` and `mutationId` must be UUIDs. Use a new `mutationId` for every logical mutation:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  "$QNOTES_URL/api/notes" \
  --data '{
    "title": "Deployment checklist",
    "contentMarkdown": "- Check backups\n- Check health endpoint\n",
    "tags": ["operations", "deployment"],
    "deviceId": "11111111-1111-4111-8111-111111111111",
    "mutationId": "22222222-2222-4222-8222-222222222222"
  }'
```

### Update a note

Requires `notes:write`. First read the note and use its current `version`. Updates replace the complete title, slug, Markdown body, and tag list:

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

If another device changed the note first, the API returns HTTP `409` with `NOTE_VERSION_CONFLICT`. Re-read the note, merge intentionally, and retry with the fresh version and a new mutation ID.

### Move a note to a notebook

Requires `notes:write`. Read the note first so that `expectedVersion` is current:

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

Set `notebookId` to `null` to return a note to the unfiled view.

### Pagination and sync

`GET /api/notes` returns up to 50 items by default and up to 500 with `limit`. If `nextCursor` is non-null, pass it back as `cursor`:

```bash
curl -fsS \
  -H "Authorization: Bearer $QNOTES_TOKEN" \
  "$QNOTES_URL/api/notes?limit=500&cursor=NEXT_CURSOR"
```

Use `GET /api/sync` for lightweight note metadata changes. It returns `changes`, `nextCursor`, and `hasMore`; persist the cursor in the calling application and continue while `hasMore` is true.

## 4. Use the `qnotes` CLI

From this repository:

```bash
pnpm install --frozen-lockfile
pnpm --filter @qnotes/cli build

export QNOTES_URL='https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api'
export QNOTES_TOKEN='qnt_paste_the_token_here'
```

Run the compiled CLI entrypoint through its workspace package:

```bash
pnpm --filter @qnotes/cli exec node dist/index.js notebooks
pnpm --filter @qnotes/cli exec node dist/index.js search 'ERPNext deployment' --hybrid
pnpm --filter @qnotes/cli exec node dist/index.js get your-note-slug --raw
pnpm --filter @qnotes/cli exec node dist/index.js capture 'Remember to rotate the staging key'
pnpm --filter @qnotes/cli exec node dist/index.js export --workspace --output backup.zip --force
```

The CLI uses native HTTP `fetch`; it never connects directly to PostgreSQL. Its available commands are shown by:

```bash
pnpm --filter @qnotes/cli exec node dist/index.js --help
```

## 5. Use the JavaScript client

The repository includes `@qnotes/api-client`, which handles the `/api` prefix, JSON envelopes, and structured HTTP errors:

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
const results = await client.search({
  query: 'ERPNext deployment',
  mode: 'keyword',
});

console.log(notebooks.items);
console.log(results);
```

## 6. MCP server status and adapter pattern

The current Quadrate Notes repository does **not** ship an MCP server or expose an MCP transport in production. `qnotes-api` is a REST API, not an MCP endpoint. An MCP client cannot connect to the REST URL as if it were an MCP server.

To give an MCP server access, run a local or hosted MCP adapter that reads these server-side environment variables:

```text
QNOTES_URL=https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api
QNOTES_TOKEN=qnt_your_scoped_token
```

Each MCP tool should call the REST API with the same header:

```js
const response = await fetch(`${process.env.QNOTES_URL}/api/notebooks`, {
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${process.env.QNOTES_TOKEN}`,
  },
});
```

A sensible read-only MCP tool mapping is:

| MCP tool | REST call | Required scope |
| --- | --- | --- |
| `qnotes_list_notes` | `GET /api/notes` | `notes:read` |
| `qnotes_get_note` | `GET /api/notes/:noteRef` | `notes:read` |
| `qnotes_list_notebooks` | `GET /api/notebooks` | `notes:read` |
| `qnotes_search` | `GET /api/search?q=...&mode=keyword` | `search:read` |
| `qnotes_get_blocks` | `GET /api/notes/:noteRef/blocks` | `notes:read` |
| `qnotes_create_note` | `POST /api/notes` | `notes:write` |
| `qnotes_update_note` | `PATCH /api/notes/:noteId` | `notes:write` |
| `qnotes_move_note` | `PATCH /api/notes/:noteId/notebook` | `notes:write` |

Keep the token in the MCP server process environment. Do not ask an end user to paste it into an MCP tool call, return it from a tool, or put it in an MCP URL. If the adapter is hosted, use HTTPS and a server-side secret store.

Because no MCP server is included today, there is no supported `codex mcp add` command or MCP URL for this project. Use the REST API or CLI now; an MCP adapter can be added later without changing the token format or API calls.

## 7. Endpoint reference

All routes except health require `Authorization: Bearer ...`.

| Method | Route | Scope |
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
| `GET` | `/api/sync` | `notes:read` |
| `GET` | `/api/export/note/:noteRef` | `notes:read` |
| `GET` | `/api/export/workspace` | `notes:read` + `attachments:read` |
| `GET` | `/api/notes/:noteRef/attachments` | `attachments:read` |
| `POST` | `/api/attachments/upload-url` | `attachments:write` |
| `POST` | `/api/attachments/:attachmentId/finalize` | `attachments:write` |
| `GET` | `/api/attachments/:attachmentId` | `attachments:read` |
| `DELETE` | `/api/attachments/:attachmentId` | `attachments:write` |

## 8. Troubleshooting and security

- `401 AUTH_REQUIRED`: the `Authorization` header is missing or empty.
- `401 INVALID_TOKEN`: the token is incorrect or belongs to another environment.
- `401 TOKEN_EXPIRED`: the token expiry has passed.
- `401` after revocation: create a new token in the settings page.
- `403 INSUFFICIENT_SCOPE`: create a token with the required scope.
- `409 NOTE_VERSION_CONFLICT`: re-read the note and retry with the current version.
- `503 SEMANTIC_SEARCH_UNAVAILABLE`: use `mode=keyword` temporarily.

Do not use the Supabase database password, service-role key, publishable key, or an Auth session token as a replacement for a personal `qnt_...` token. If a personal token is exposed, revoke it immediately from [Personal API tokens](https://notes.quadrate.lk/settings/tokens) and create a replacement.
