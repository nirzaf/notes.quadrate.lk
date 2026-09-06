# Fetching Quadrate Notes from Shared Links

This guide explains how an AI agent can retrieve a shared Quadrate Notes note as Markdown. A shared link is read-only, does not require a user JWT, and exposes only the saved note title and Markdown body. Attachments, notebooks, workspace metadata, and other notes are not exposed.

## Identify the link type

The web-app link looks like this:

```text
https://notes.quadrate.lk/share#qns_<secret>
```

That URL is intended for a browser. The token is after `#`, so browsers do not send it to the server as part of the request URL. An agent should not fetch this page and expect the response to be Markdown.

Use the public resolver endpoint instead:

```text
https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/public/share/resolve?token=qns_<secret>
```

The share dialog displays the raw resolver endpoint immediately after a link is created. If an agent receives only the browser URL, it can read the fragment locally and put that token in the resolver request; do not send the browser URL as the API request.

## Fetch the raw Markdown

The `GET` endpoint returns the exact saved `contentMarkdown` value. No `Authorization` header or personal API token is needed.

```bash
export QNOTES_SHARE_TOKEN='qns_<secret>'

curl --fail --silent --show-error --location --get \
  -H 'Accept: text/markdown' \
  --data-urlencode "token=$QNOTES_SHARE_TOKEN" \
  'https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/public/share/resolve'
```

To save the result for processing, add `-o note.md`. `--data-urlencode` is preferred because it safely encodes the token as a query parameter.

Equivalent JavaScript/TypeScript:

```js
const apiUrl = new URL(
  "https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/public/share/resolve",
);
apiUrl.searchParams.set("token", shareToken);

const response = await fetch(apiUrl, {
  headers: { Accept: "text/markdown" },
});

if (!response.ok) {
  throw new Error(`Shared note unavailable (HTTP ${response.status})`);
}

const markdown = await response.text();
```

Use `response.text()`, not `response.json()`. The successful response has `Content-Type: text/markdown; charset=utf-8`.

## When JSON metadata is needed

If the agent also needs the note title or last-updated timestamp, use the JSON resolver with `POST`:

```bash
curl --fail --silent --show-error -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  'https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/public/share/resolve' \
  --data '{"token":"qns_<secret>"}'
```

The response is shaped as `{ "data": { "title", "contentMarkdown", "updatedAt" } }`. For Markdown-only workflows, prefer `GET` so the agent receives the note body directly.

## Fetch through MCP

The native and hosted read-only MCP profiles expose the same public resolver as `resolve_public_share`. Call it with the exact `qns_...` token:

```json
{
  "name": "resolve_public_share",
  "arguments": {
    "token": "qns_<secret>"
  }
}
```

The tool delegates to the existing API-client resolver and returns structured `title`, `contentMarkdown`, and `updatedAt` fields. It does not require a private JWT and does not expose attachments or workspace metadata. Public-share creation and revocation remain owner-session REST operations; they are intentionally not part of the default read-only MCP surface.

## Errors and security rules

- A valid, active share returns HTTP 200. Invalid, expired, revoked, deleted, malformed, or wrong-format tokens all return the same HTTP 404 `PUBLIC_SHARE_NOT_FOUND` response.
- Treat the token—and especially the complete GET URL—as a bearer secret. Use HTTPS, do not include it in prompts or public documentation, and redact it from logs, traces, and error reports.
- The endpoint is deliberately `no-store`, `noindex`, and `no-referrer`. Agents should not cache or publish the response unless the note owner explicitly asks them to.
- A shared link can be expired, rotated, or revoked by its owner. On a 404, report that the link is unavailable or no longer active; do not infer which token state caused it.

For the complete REST and MCP access contract, see [API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md).
