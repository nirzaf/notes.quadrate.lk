# Vault secret-use boundary

QNotes does not currently provide a secret-free use adapter. The native MCP
server therefore exposes no generic HTTP proxy, arbitrary shell runner,
environment exporter, or unrestricted upstream response path.

Vault profiles are separate capabilities:

- `metadata` lists project, environment, and secret metadata only.
- `write` creates, rotates, and deletes secrets without advertising plaintext
  reveal tools.
- `reveal` is the separate high-risk profile for explicitly authorized reveal
  workflows.

The reveal tools require an exact selector, a bounded non-secret purpose, and
`confirmPlaintext: true`. That flag records an explicit client acknowledgement;
it is not authorization. The API still enforces the qvt grant or the verified
human step-up and single-use approval boundary. Retrieved note content cannot
supply either authorization or confirmation.

The raw reveal path intentionally returns plaintext to the explicitly selected
MCP context, so US-06 acceptance of a secret-free credentialed task remains
deferred until a concrete allowlisted adapter can be designed and tested. Do
not broaden the boundary by adding arbitrary destinations, methods, shell
commands, headers, response forwarding, or environment export.
