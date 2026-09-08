import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const VAULT_TOKEN_PEPPER_NAME = 'QNOTES_VAULT_TOKEN_PEPPER';

export const VAULT_METADATA_TABLES = [
  'vault_projects',
  'vault_environments',
  'vault_secrets',
  'vault_agent_tokens',
  'vault_agent_grants',
  'vault_audit_events',
  'vault_mutations',
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
    id: 'create_agent_token',
    name: 'qnotes_create_vault_agent_token',
    signature: 'uuid,text,text,text,timestamptz,jsonb',
  },
  {
    id: 'replace_agent_grants',
    name: 'qnotes_replace_vault_agent_grants',
    signature: 'uuid,uuid,jsonb',
  },
  {
    id: 'reveal_secrets_batch',
    name: 'qnotes_vault_reveal_secrets',
    signature: 'uuid,jsonb,uuid,text,uuid,text',
  },
];

const baseReadinessChecks = [
  { key: 'vault_extension', label: 'supabase_vault extension' },
  { key: 'vault_schema', label: 'vault schema' },
  ...VAULT_METADATA_TABLES.map((table) => ({
    key: `vault_table_${table}`,
    label: `Vault metadata table ${table}`,
  })),
];

export const VAULT_READINESS_CHECKS = [
  ...baseReadinessChecks,
  ...VAULT_RPC_CHECKS.flatMap(({ id, name }) => [
    { key: `vault_rpc_${id}_exists`, label: `Vault RPC ${name}` },
    { key: `vault_rpc_${id}_anon_denied`, label: `Vault RPC ${name} denies anon` },
    { key: `vault_rpc_${id}_authenticated_denied`, label: `Vault RPC ${name} denies authenticated` },
    { key: `vault_rpc_${id}_service_role_allowed`, label: `Vault RPC ${name} allows service_role` },
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

const readinessExpressions = [
  `exists (select 1 from pg_extension where extname = 'supabase_vault') as vault_extension`,
  `to_regnamespace('vault') is not null as vault_schema`,
  ...VAULT_METADATA_TABLES.map((table) => `to_regclass(${sqlString(`notesdb.${table}`)}) is not null as vault_table_${table}`),
  ...VAULT_RPC_CHECKS.flatMap((rpc) => [
    `${rpcOid(rpc)} is not null as vault_rpc_${rpc.id}_exists`,
    `${privilegeCheck(rpc, 'anon', false)} as vault_rpc_${rpc.id}_anon_denied`,
    `${privilegeCheck(rpc, 'authenticated', false)} as vault_rpc_${rpc.id}_authenticated_denied`,
    `${privilegeCheck(rpc, 'service_role', true)} as vault_rpc_${rpc.id}_service_role_allowed`,
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
  return { pepperPresent: true, checks };
}

async function main() {
  const result = await verifyVaultReadiness({ projectId: process.env.SUPABASE_PROJECT_ID });
  console.log(`Vault production readiness passed: ${VAULT_TOKEN_PEPPER_NAME} is present by name; ${Object.keys(result.checks).length} boolean database checks passed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    console.error(`[verify:vault] ${error instanceof Error ? error.message : 'Vault readiness verification failed.'}`);
    process.exitCode = 1;
  });
}
