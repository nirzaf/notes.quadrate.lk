import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const VAULT_TOKEN_PEPPER_NAME = 'QNOTES_VAULT_TOKEN_PEPPER';

// This gate proves the current privilege contract. It does not prove that the
// notes runtime is isolated from the Supabase Vault deployment.
export const VAULT_ISOLATION = Object.freeze({
  status: 'open_residual',
  reason: 'The notes runtime and Vault still share the current Supabase project and service-role trust zone.',
});

export const VAULT_METADATA_TABLES = [
  'vault_projects',
  'vault_environments',
  'vault_secrets',
  'vault_agent_tokens',
  'vault_agent_grants',
  'vault_audit_events',
  'vault_mutations',
  'vault_security_policy',
  'vault_operation_approvals',
  'vault_audit_policy',
  'vault_audit_outbox',
];

export const VAULT_RPC_CHECKS = [
  {
    id: 'create_secret',
    name: 'qnotes_vault_create_secret',
    signature: 'uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid,text',
  },
  {
    id: 'rotate_secret',
    name: 'qnotes_vault_rotate_secret',
    signature: 'uuid,uuid,text,text,bigint,uuid,text,text,uuid,uuid,text',
  },
  {
    id: 'rotate_secret_legacy',
    name: 'qnotes_vault_rotate_secret',
    signature: 'uuid,uuid,text,text,bigint,uuid,text,uuid,uuid,text',
  },
  {
    id: 'delete_secret',
    name: 'qnotes_vault_delete_secret',
    signature: 'uuid,uuid,bigint,uuid,text,uuid,uuid,text',
  },
  {
    id: 'reveal_secret',
    name: 'qnotes_vault_reveal_secret',
    signature: 'uuid,uuid,uuid,text,uuid,text',
  },
  {
    id: 'resolve_resource',
    name: 'qnotes_vault_resolve_resource',
    signature: 'uuid,uuid,text,text,uuid,text,uuid,text,uuid,text,uuid',
  },
  {
    id: 'create_agent_token',
    name: 'qnotes_create_vault_agent_token',
    signature: 'uuid,text,text,text,timestamptz,jsonb,uuid',
  },
  {
    id: 'replace_agent_grants',
    name: 'qnotes_replace_vault_agent_grants',
    signature: 'uuid,uuid,jsonb,uuid',
  },
  {
    id: 'revoke_agent_token',
    name: 'qnotes_revoke_vault_agent_token',
    signature: 'uuid,uuid,uuid',
  },
  {
    id: 'reveal_secrets_batch',
    name: 'qnotes_vault_reveal_secrets',
    signature: 'uuid,jsonb,uuid,text,uuid,text',
  },
  {
    id: 'issue_operation_approval',
    name: 'qnotes_issue_vault_operation_approval',
    signature: 'uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,uuid',
  },
  {
    id: 'consume_operation_approval',
    name: 'qnotes_consume_vault_operation_approval',
    signature: 'uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,uuid',
  },
  {
    id: 'append_audit_event',
    name: 'qnotes_vault_append_audit_event',
    signature: 'uuid,text,uuid,text,uuid,uuid,uuid,text,boolean,text,uuid,uuid,uuid',
  },
  {
    id: 'claim_audit_outbox',
    name: 'qnotes_vault_claim_audit_outbox',
    signature: 'integer',
  },
  {
    id: 'ack_audit_outbox',
    name: 'qnotes_vault_ack_audit_outbox',
    signature: 'uuid,uuid',
  },
  {
    id: 'retry_audit_outbox',
    name: 'qnotes_vault_retry_audit_outbox',
    signature: 'uuid,uuid,text',
  },
  {
    id: 'purge_audit_events',
    name: 'qnotes_vault_purge_expired_audit_events',
    signature: 'timestamptz',
    serviceRoleAllowed: false,
  },
];

export const VAULT_TABLE_PRIVILEGE_CHECKS = [
  { id: 'audit_events_select', table: 'vault_audit_events', privilege: 'SELECT', expected: true },
  { id: 'audit_events_insert_denied', table: 'vault_audit_events', privilege: 'INSERT', expected: false },
  { id: 'audit_events_update_denied', table: 'vault_audit_events', privilege: 'UPDATE', expected: false },
  { id: 'audit_events_delete_denied', table: 'vault_audit_events', privilege: 'DELETE', expected: false },
  { id: 'audit_outbox_select_denied', table: 'vault_audit_outbox', privilege: 'SELECT', expected: false },
  { id: 'audit_outbox_insert_denied', table: 'vault_audit_outbox', privilege: 'INSERT', expected: false },
  { id: 'audit_outbox_update_denied', table: 'vault_audit_outbox', privilege: 'UPDATE', expected: false },
  { id: 'audit_outbox_delete_denied', table: 'vault_audit_outbox', privilege: 'DELETE', expected: false },
];

const baseReadinessChecks = [
  { key: 'vault_extension', label: 'supabase_vault extension' },
  { key: 'vault_schema', label: 'vault schema' },
  ...VAULT_METADATA_TABLES.map((table) => ({
    key: `vault_table_${table}`,
    label: `Vault metadata table ${table}`,
  })),
];

function serviceRoleKey(rpc) {
  return rpc.serviceRoleAllowed === false ? 'service_role_denied' : 'service_role_allowed';
}

export const VAULT_READINESS_CHECKS = [
  ...baseReadinessChecks,
  ...VAULT_TABLE_PRIVILEGE_CHECKS.map((check) => ({
    key: `vault_table_privilege_${check.id}`,
    label: `service_role ${check.expected ? 'has' : 'does not have'} ${check.privilege} on ${check.table}`,
  })),
  ...VAULT_RPC_CHECKS.flatMap((rpc) => [
    { key: `vault_rpc_${rpc.id}_exists`, label: `Vault RPC ${rpc.name}` },
    { key: `vault_rpc_${rpc.id}_anon_denied`, label: `Vault RPC ${rpc.name} denies anon` },
    { key: `vault_rpc_${rpc.id}_authenticated_denied`, label: `Vault RPC ${rpc.name} denies authenticated` },
    { key: `vault_rpc_${rpc.id}_${serviceRoleKey(rpc)}`, label: `Vault RPC ${rpc.name} ${rpc.serviceRoleAllowed === false ? 'denies' : 'allows'} service_role` },
  ]),
];

const readinessKeys = VAULT_READINESS_CHECKS.map(({ key }) => key);

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function rpcOid({ name, signature }) {
  return `to_regprocedure(${sqlString(`public.${name}(${signature})`)})::oid`;
}

function privilegeCheck(rpc, role, expected) {
  const expression = expected ? 'has_function_privilege' : 'not has_function_privilege';
  return `coalesce((select ${expression}(${sqlString(role)}, p.oid, 'EXECUTE') from pg_proc p where p.oid = ${rpcOid(rpc)}), false)`;
}

function tablePrivilegeCheck({ table, privilege, expected }) {
  const relation = `to_regclass(${sqlString(`notesdb.${table}`)})`;
  const check = `has_table_privilege(${sqlString('service_role')}, ${relation}, ${sqlString(privilege)})`;
  return `case when ${relation} is null then false else coalesce(${expected ? check : `not ${check}`}, false) end`;
}

const readinessExpressions = [
  `exists (select 1 from pg_extension where extname = 'supabase_vault') as vault_extension`,
  `to_regnamespace('vault') is not null as vault_schema`,
  ...VAULT_METADATA_TABLES.map((table) => `to_regclass(${sqlString(`notesdb.${table}`)}) is not null as vault_table_${table}`),
  ...VAULT_TABLE_PRIVILEGE_CHECKS.map((check) => `${tablePrivilegeCheck(check)} as vault_table_privilege_${check.id}`),
  ...VAULT_RPC_CHECKS.flatMap((rpc) => [
    `${rpcOid(rpc)} is not null as vault_rpc_${rpc.id}_exists`,
    `${privilegeCheck(rpc, 'anon', false)} as vault_rpc_${rpc.id}_anon_denied`,
    `${privilegeCheck(rpc, 'authenticated', false)} as vault_rpc_${rpc.id}_authenticated_denied`,
    `${privilegeCheck(rpc, 'service_role', rpc.serviceRoleAllowed !== false)} as vault_rpc_${rpc.id}_${serviceRoleKey(rpc)}`,
  ]),
];

export const VAULT_READINESS_SQL = `select\n  ${readinessExpressions.join(',\n  ')}\n;`;

function malformedOutput(label) {
  return new Error(`${label} returned malformed output.`);
}

function parseJsonOutput(raw, label) {
  if (typeof raw !== 'string' || !raw.trim()) throw malformedOutput(label);
  try {
    return JSON.parse(raw);
  } catch {
    throw malformedOutput(label);
  }
}

function rowsFromOutput(raw, label) {
  const parsed = parseJsonOutput(raw, label);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['rows', 'result', 'data']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
  }
  throw malformedOutput(label);
}

export function parseSecretNames(raw) {
  const parsed = parseJsonOutput(raw, 'Supabase secrets list');
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Object.hasOwn(parsed, 'secrets') ||
    !Array.isArray(parsed.secrets) ||
    !Object.hasOwn(parsed, 'message') ||
    typeof parsed.message !== 'string'
  ) {
    throw malformedOutput('Supabase secrets list');
  }

  const names = new Set();
  for (const row of parsed.secrets) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.name !== 'string' || !row.name.trim()) {
      throw malformedOutput('Supabase secrets list');
    }
    names.add(row.name);
  }
  return names;
}

export function assertVaultTokenPepperPresent(raw) {
  if (!parseSecretNames(raw).has(VAULT_TOKEN_PEPPER_NAME)) {
    throw new Error(`Missing required production Supabase secret by name: ${VAULT_TOKEN_PEPPER_NAME}. Secret values are ignored and never logged.`);
  }
}

export function parseReadinessChecks(raw) {
  const rows = rowsFromOutput(raw, 'Supabase linked database readiness query');
  if (rows.length !== 1) throw malformedOutput('Supabase linked database readiness query');
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw malformedOutput('Supabase linked database readiness query');

  const actualKeys = Object.keys(row).sort();
  const expectedKeys = [...readinessKeys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw malformedOutput('Supabase linked database readiness query');
  }
  for (const key of readinessKeys) {
    if (typeof row[key] !== 'boolean') throw malformedOutput('Supabase linked database readiness query');
  }
  return row;
}

export function assertReadinessChecksPassed(checks) {
  const failed = readinessKeys.filter((key) => checks?.[key] !== true);
  if (failed.length) {
    throw new Error(`Vault production readiness failed; false checks: ${failed.join(', ')}.`);
  }
}

async function executeSupabaseCommand(args) {
  try {
    const { stdout } = await execFileAsync('pnpm', args, {
      cwd: root,
      maxBuffer: 2_000_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw new Error('The pinned Supabase CLI command failed or was unavailable. Command output was suppressed.');
  }
}

function projectIdFrom(value) {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value)) {
    throw new Error('SUPABASE_PROJECT_ID is required and must be a project reference without whitespace.');
  }
  return value;
}

async function commandOutput(runCommand, args, label) {
  try {
    const output = await runCommand(args);
    if (typeof output !== 'string') throw new Error('non-string output');
    return output;
  } catch {
    throw new Error(`${label} was unavailable or failed. Command output was suppressed.`);
  }
}

export async function verifyVaultReadiness({ projectId, runCommand = executeSupabaseCommand } = {}) {
  const resolvedProjectId = projectIdFrom(projectId);
  const secretsOutput = await commandOutput(runCommand, [
    'exec',
    'supabase',
    'secrets',
    'list',
    '--project-ref',
    resolvedProjectId,
    '--output-format',
    'json',
  ], 'Supabase secrets list');
  assertVaultTokenPepperPresent(secretsOutput);

  const readinessOutput = await commandOutput(runCommand, [
    'exec',
    'supabase',
    'db',
    'query',
    '--linked',
    '--project-ref',
    resolvedProjectId,
    '--output-format',
    'json',
    VAULT_READINESS_SQL,
  ], 'Supabase linked database readiness query');
  const checks = parseReadinessChecks(readinessOutput);
  assertReadinessChecksPassed(checks);
  return { pepperPresent: true, checks, isolation: VAULT_ISOLATION };
}

export function formatReadinessResult(result) {
  return JSON.stringify({
    pepperPresent: result.pepperPresent,
    checks: result.checks,
    isolation: result.isolation,
  });
}

async function main() {
  const result = await verifyVaultReadiness({ projectId: process.env.SUPABASE_PROJECT_ID });
  console.log(formatReadinessResult(result));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(`[verify:vault] ${error instanceof Error ? error.message : 'Vault readiness verification failed.'}`);
    process.exitCode = 1;
  });
}
