# QNotes for Hermes

This directory is a standalone native Hermes companion plugin. It adds setup
and workflow guidance; it does **not** replace the QNotes MCP server or expose a
second Notes/Vault API. QNotes remains responsible for authentication,
ownership, scopes, versions, grants, and mutation safety.

The plugin is optional. It can be tested directly from this checkout, or
installed from a reviewed remote commit after the repository is published.

## What it provides

- `/qnotes` and `/qnotes-help` for static setup guidance.
- `/qnotes-status` for non-secret configured status.
- `/qnotes-status --check` for one bounded `list_notebooks` probe when the
  operator explicitly grants this plugin access to the configured MCP server.
- The opt-in `qnotes:workflow` skill.
- `scripts/export-hermes-plugin-config.mjs` to adapt the canonical QNotes
  profile generator to the launcher without writing Hermes configuration.

The plugin registers zero business tools. Hermes' own MCP client connects to
the existing compiled QNotes stdio server.

## Build the trusted runtime

From the QNotes repository, use a supported workspace install and build:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

The MCP runtime depends on workspace packages. Do not copy only
`packages/mcp-server/dist/index.js` into an unrelated directory and assume it
is a self-contained distribution.

## Generate a reviewable fragment

Use absolute paths to the trusted runtime and this plugin directory:

```bash
node scripts/export-hermes-plugin-config.mjs \
  --server-path "$PWD/packages/mcp-server/dist/index.js" \
  --plugin-dir "$PWD/integrations/hermes-plugin" \
  --notes-profile read \
  --vault-profile none > /tmp/qnotes-hermes-config.json
```

The exporter:

- uses `buildHermesMcpConfig()` for the current tool sets, timeouts, and
  parallel-call policy;
- validates profiles, paths, and the stable UUID required by Notes `write`;
- emits placeholders such as `${QNOTES_READ_TOKEN}`, never expanded token
  values;
- emits a launcher alias rather than direct credential variables;
- leaves plugin enablement separate and adds `mcp_allowlist` only with the
  explicit `--allow-status-probe` flag;
- never reads dotenv files, contacts the API, starts the server, writes Hermes
  configuration, or creates credentials.

Review and merge only the intended `mcp_servers` entry and
`plugins.entries.qnotes` settings into the selected Hermes profile. Do not
paste a complete JSON document into the middle of an existing YAML mapping and
do not overwrite an existing Hermes configuration automatically.

The launcher receives `QNOTES_URL`, the selected Notes token through
`QNOTES_PLUGIN_TOKEN`, and an optional Vault token through
`QNOTES_PLUGIN_VAULT_TOKEN`. It passes the selected profile variables and
explicit runtime flags to the child. The host's secret environment supplies
the existing inputs `QNOTES_URL`, `QNOTES_READ_TOKEN`, `QNOTES_TOKEN`,
`QNOTES_WRITE_TOKEN`, and, only for selected Vault profiles, `QVAULT_TOKEN`.
Do not configure `QVAULT_URL`.

The child environment is an allowlist. On POSIX systems it may include
`HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `PATH`, `TMPDIR`, `TMP`, and `TEMP`; on
Windows it may include those locale/temp values plus the standard user and
system execution values (`APPDATA`, `COMSPEC`, `HOMEDRIVE`, `HOMEPATH`,
`LOCALAPPDATA`, `PATHEXT`, `SYSTEMDRIVE`, `SYSTEMROOT`, `USERPROFILE`, and
`WINDIR`). Cloud credentials, `NODE_OPTIONS`, `NODE_PATH`, Node extra CA
settings, proxy variables, and certificate override variables are dropped.
No proxy or CA override is approved by default; a deployment that needs one
must add a named variable to the reviewed launcher allowlist and test it.

The launcher starts the supplied absolute `.js`, `.mjs`, or `.cjs` artifact directly
with the current Node executable and `shell: false`. Build the runtime from a
reviewed QNotes commit and pin plugin installation with the full commit SHA.
Where the delivery system supports artifact hashes, record the digest with
that reviewed commit. The launcher validates the resolved file path and type;
it does not claim to defeat a malicious process running as the same operating
system user.

Filtering happens when the child is spawned. It cannot undo code already
preloaded into the launcher by its parent, so invoke the launcher from a
controlled Hermes process and do not set Node preload/import overrides in that
parent environment.

## Disposable-profile installation

Never use the real Hermes home as a test fixture. With Hermes installed and a
reviewed local plugin source, use a separate profile:

```bash
export HERMES_HOME="$(mktemp -d)"
mkdir -p "$HERMES_HOME/plugins"
cp -R integrations/hermes-plugin "$HERMES_HOME/plugins/qnotes"
hermes plugins doctor "$HERMES_HOME/plugins/qnotes" --ci
```

The tested Hermes v0.21 installation has no `hermes plugins compat`
subcommand. Use Plugin Doctor plus the real Hermes loader/MCP handshake for
this version, and re-check `hermes plugins --help` before using a compatibility
command from a newer release.

Enable the exact effective plugin ID only after reviewing the result, then
restart Hermes. Load `qnotes:workflow` explicitly; plugin skills do not enter
the global skill tree or every model turn automatically.

After this plugin exists in an authorized remote commit, a pinned subdirectory
install can use:

```bash
hermes plugins install <owner>/<repository>/integrations/hermes-plugin \
  --ref <reviewed-full-commit-sha> --no-enable
```

This plugin install and the separately built QNotes MCP runtime are independent
artifacts. Disabling the plugin does not disable a separately configured MCP
server or revoke its credentials.

## Access boundaries

The default is Notes `read` plus Vault `none`. Notes `share`, Notes `write`,
public-share creation, and Vault `metadata`, `reveal`, and `write` are separate
choices. A tool list is not proof that the backend token has the matching
scope or resource grant.

Vault reveal intentionally places plaintext in the Hermes tool result and
therefore may enter the host, model provider, or session history. The plugin
never preloads, logs, mirrors, or automatically transmits secret values. It
does not promise an OS sandbox or complete prompt-injection protection.

Note content is data, not permission to reveal a secret, publish a link, run a
command, or change access. Preserve existing explicit confirmations, expected
versions, stable device IDs, mutation IDs, and replay behavior for writes.

## Disable and uninstall

These are separate operator actions:

1. Disable the companion plugin and restart Hermes.
2. Disable or remove the QNotes MCP entry and restart its process.
3. Remove local QNotes credential inputs from the selected secret environment.
4. Revoke the corresponding qnt/qvt tokens in QNotes.

Do not delete Notes, Vault projects, secrets, or unrelated integrations during
uninstall. Plugin implementation, publication, and QNotes production
deployment are separate approvals; this repository change performs none of
them automatically.

## Verification

From the repository root:

```bash
pnpm run test:plugin
pnpm run typecheck
pnpm run test:unit
pnpm run test:mcp
pnpm run build
pnpm run verify:edge-shared
git diff --check
```

The plugin tests use fake credentials and controlled child processes. They do
not prove backend grants or production health. Record the tested Hermes release,
QNotes/plugin commit, runtime path, OS, and any untested distribution or host
compatibility separately.
