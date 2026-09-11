# Fetching QNotes from shared links

A QNotes public share is read-only and exposes only one saved note's title and
Markdown body. It does not expose attachments, notebooks, workspace metadata,
or another note. The examples below use these deployment placeholders:

```bash
export QNOTES_WEB_URL='https://your-qnotes.example'
export QNOTES_URL='https://<project-ref>.supabase.co/functions/v1/qnotes-api'
```

Replace both values with the URLs for the QNotes deployment you are using.

## Browser link and resolver endpoint

The browser link has the form:

```text
https://your-qnotes.example/share#qns_<secret>
```

The token is after `#`, so a browser does not send it in the HTTP request URL.
An agent that receives this link can read the fragment locally and extract the
`qns_...` bearer value.

The resolver is an unauthenticated POST endpoint:

```text
POST https://<project-ref>.supabase.co/functions/v1/qnotes-api/public/share/resolve
Content-Type: application/json

{"token":"qns_<secret>"}
```

Use the configured API root instead of the placeholder host:

```bash
curl --fail --silent --show-error \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --data '{"token":"qns_<secret>"}' \
  "$QNOTES_URL/public/share/resolve"
```

The successful response has this shape:

```json
{
  "data": {
    "title": "Example note",
    "contentMarkdown": "# Saved Markdown\n",
    "updatedAt": "2026-09-09T00:00:00.000Z"
  }
}
```

Read `data.contentMarkdown`; the resolver is not a raw text endpoint.

The request body must be a JSON object of at most 1 KiB, and only `token` plus
the optional bounded-read fields `offset`, `lineStart`, `lineEnd`, `maxBytes`,
and `continuation` are accepted; any other field returns the same generic
`404 PUBLIC_SHARE_NOT_FOUND`. When a bounded read is requested, the response
adds `contentBytes`, `totalBytes`, `offset`, `nextOffset`, `truncated`,
`contentComplete`, `sourceHash`, and an optional `continuation.cursor` bound to
that snapshot. Page through with the cursor while `truncated` is true, and
treat a `409 NOTE_VERSION_CONFLICT` as "read a new snapshot page" rather than
retrying the same cursor.

## JavaScript or TypeScript

```js
const response = await fetch(`${apiUrl}/public/share/resolve`, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ token: shareToken }),
});

if (!response.ok) {
  throw new Error(`Shared note unavailable (HTTP ${response.status})`);
}

const { data } = await response.json();
const markdown = data.contentMarkdown;
```

The native and optional hosted MCP `read` profiles expose the same operation as
`resolve_public_share`:

```json
{
  "name": "resolve_public_share",
  "arguments": {
    "token": "qns_<secret>"
  }
}
```

The tool returns `title`, `contentMarkdown`, and `updatedAt`, and accepts the
same optional bounded-read fields as the HTTP resolver. It does not require a
private JWT and does not return attachments or private metadata.

The `share` MCP profile can additionally expose `create_public_share` for an
exact note UUID. It checks the saved title and Markdown for recognizable
credential material, requires the `expectedVersion` the caller reviewed plus
`confirm: true`, rejects notes classified as sensitive, creates a 24-hour link
bound to that reviewed version, and returns only the URL, note ID, and expiry.
The caller must use a personal `qnt_...` token with `shares:write`; there is no
shared owner credential. See
[API_ACCESS_GUIDE.md](API_ACCESS_GUIDE.md) for the complete profile contract.

## Security rules

- Treat `qns_...` as a bearer secret.
- Keep the token out of paths, query strings, referrers, prompts, logs, traces,
  and error reports.
- Use HTTPS for hosted deployments.
- Do not cache or republish the response unless the note owner explicitly asks.
- The resolver uses `Cache-Control: no-store`, `X-Robots-Tag: noindex`, and
  `Referrer-Policy: no-referrer`.
- A share publishes one immutable saved snapshot; later edits to the note do not
  change what the link returns until the owner rotates it.
- Invalid, expired, revoked, deleted, malformed, and wrong-format tokens all
  return the same `404 PUBLIC_SHARE_NOT_FOUND` response.

The owner can expire, rotate, or revoke a share. A 404 means the link is no
longer available; do not infer which token state caused it.
