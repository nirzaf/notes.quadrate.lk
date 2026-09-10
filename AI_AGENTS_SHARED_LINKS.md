# Fetching QNotes from Shared Links

This guide explains how an AI agent can retrieve a shared QNotes note. A shared link is read-only, does not require a user JWT, and exposes only the saved note title and Markdown body. Attachments, notebooks, workspace metadata, and other notes are not exposed.

## Identify the link type

The web-app link looks like this:

```text
https://notes.quadrate.lk/share#qns_<secret>
```

That URL is intended for a browser. The token is after `#`, so browsers do not send it to the server as part of the request URL. If an agent receives only this browser link, it can read the fragment locally and extract the `qns_...` token.

The public resolver is a POST endpoint:

```text
POST https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/public/share/resolve
Content-Type: application/json

{"token":"qns_<secret>"}
```

Do not put the token in a path, query string, referrer, prompt transcript, or log. The share dialog does not construct or retain another secret-bearing URL.

## Fetch the note with HTTP

The resolver returns the exact saved `contentMarkdown` value inside a JSON response. No `Authorization` header or personal API token is needed.

```bash
export QNOTES_PUBLIC_SHARE_TOKEN='qns_<secret>'

curl --fail --silent --show-error \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --data "{\"token\":\"$QNOTES_PUBLIC_SHARE_TOKEN\"}" \
  'https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/public/share/resolve'
```

The successful response has the shape `{ "data": { "title", "contentMarkdown", "updatedAt" } }`. Pass `data.contentMarkdown` to the next agent step or save that field as `note.md`.

Equivalent JavaScript/TypeScript:

```js
const response = await fetch(
  "https://ciyoandzjezgqxjpcrin.supabase.co/functions/v1/qnotes-api/public/share/resolve",
  {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: shareToken }),
  },
);

if (!response.ok) {
  throw new Error(`Shared note unavailable (HTTP ${response.status})`);
}

const { data } = await response.json();
const markdown = data.contentMarkdown;
```

Use `response.json()` and read `data.contentMarkdown`; the resolver is not a raw text endpoint.

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

The tool delegates to the existing API-client resolver and returns structured `title`, `contentMarkdown`, and `updatedAt` fields. It is read-only, does not require a private JWT, and does not expose attachments or workspace metadata. The native and optional hosted `share` profiles also expose `create_public_share` for an exact UUID note. Call it only after reading and reviewing the saved note version:

```json
{
  "name": "create_public_share",
  "arguments": {
    "noteId": "00000000-0000-4000-8000-000000000001",
    "expectedVersion": 7,
    "confirm": true
  }
}
```

That tool uses the same caller-owned `qnt_...` personal token as the rest of the MCP connection, pre-reads the title and Markdown, blocks obvious credential material without copying note content into errors or logs, and returns a `https://notes.quadrate.lk/share#qns_...` URL that expires exactly 24 hours after invocation. The legacy `{ "noteId": "..." }` input remains parseable for deployed clients but fails closed with a migration error; the server never infers a reviewed version or creates a snapshot without `expectedVersion` and `confirm: true`. The token must include `shares:write`; no shared owner JWT or server-side share credential is used. The same `shares:write` token can manage that owner’s share through the REST get/create/revoke routes.

## Errors and security rules

- A valid, active share returns HTTP 200. Invalid, expired, revoked, deleted, malformed, or wrong-format tokens all return the same HTTP 404 `PUBLIC_SHARE_NOT_FOUND` response.
- The resolver accepts the token only in the POST JSON body. Other methods, including a request that supplies the token as a query parameter, are not supported.
- Treat the token as a bearer secret. Use HTTPS, keep it out of prompts and public documentation, and redact it from logs, traces, and error reports.
- The endpoint is deliberately `no-store`, `noindex`, and `no-referrer`. Agents should not cache or publish the response unless the note owner explicitly asks them to.
- A shared link can be expired, rotated, or revoked by its owner. On a 404, report that the link is unavailable or no longer active; do not infer which token state caused it.

For the complete REST and MCP access contract, see [API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md).
