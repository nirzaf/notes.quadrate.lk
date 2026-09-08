import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VAULT_READINESS_CHECKS,
  VAULT_READINESS_SQL,
  VAULT_TOKEN_PEPPER_NAME,
  assertReadinessChecksPassed,
  assertVaultTokenPepperPresent,
  parseReadinessChecks,
  parseSecretNames,
  verifyVaultReadiness,
} from '../verify-vault-readiness.mjs';

function readyChecks() {
  return Object.fromEntries(VAULT_READINESS_CHECKS.map(({ key }) => [key, true]));
}

function secretsListOutput(secrets) {
  return JSON.stringify({
    secrets,
    message: 'Secret values are not returned by the CLI response.',
  });
}

test('parses secret names without returning or logging secret values', () => {
  const names = parseSecretNames(secretsListOutput([
    { name: 'QNOTES_TOKEN_PEPPER', value: 'synthetic-notes-value' },
    { name: VAULT_TOKEN_PEPPER_NAME, value: 'synthetic-vault-value' },
  ]));

  assert.deepEqual([...names], ['QNOTES_TOKEN_PEPPER', VAULT_TOKEN_PEPPER_NAME]);
  assert.equal(names.has('synthetic-vault-value'), false);
  assert.doesNotMatch(JSON.stringify(names), /synthetic-(?:notes|vault)-value/);
  assert.doesNotThrow(() => assertVaultTokenPepperPresent(secretsListOutput([
    { name: VAULT_TOKEN_PEPPER_NAME, value: 'synthetic-vault-value' },
  ])));
});

test('fails clearly when the pepper is absent or secrets output is malformed', () => {
  assert.throws(
    () => assertVaultTokenPepperPresent(secretsListOutput([
      { name: 'QNOTES_TOKEN_PEPPER', value: 'synthetic-value' },
    ])),
    (error) => error.message.includes(`Missing required production Supabase secret by name: ${VAULT_TOKEN_PEPPER_NAME}`)
      && !error.message.includes('synthetic-value'),
  );
  assert.throws(() => parseSecretNames('{not-json'), /Supabase secrets list returned malformed output/);
  assert.throws(() => parseSecretNames(JSON.stringify([{ name: VAULT_TOKEN_PEPPER_NAME }])), /Supabase secrets list returned malformed output/);
  assert.throws(() => parseSecretNames(JSON.stringify({ secrets: [{ value: 'synthetic-value' }], message: 'malformed entry' })), /Supabase secrets list returned malformed output/);
  assert.throws(() => parseSecretNames(JSON.stringify({ secrets: [{ name: VAULT_TOKEN_PEPPER_NAME }]})), /Supabase secrets list returned malformed output/);
});

test('accepts only one boolean-only readiness row with the complete expected shape', () => {
  const checks = readyChecks();
  assert.deepEqual(parseReadinessChecks(JSON.stringify([checks])), checks);
  assert.throws(
    () => parseReadinessChecks(JSON.stringify([{ ...checks, vault_schema: 'true' }])),
    /Supabase linked database readiness query returned malformed output/,
  );
  assert.throws(
    () => parseReadinessChecks(JSON.stringify([{ ...checks, unexpected: true }])),
    /Supabase linked database readiness query returned malformed output/,
  );
});

test('reports every false readiness check without exposing database output', () => {
  const checks = readyChecks();
  checks.vault_rpc_reveal_secrets_batch_service_role_allowed = false;
  assert.throws(
    () => assertReadinessChecksPassed(checks),
    /vault_rpc_reveal_secrets_batch_service_role_allowed/,
  );
});

test('uses only the pinned read-only Supabase primitives and verifies them in order', async () => {
  const calls = [];
  const checks = readyChecks();
  const result = await verifyVaultReadiness({
    projectId: 'ciyoandzjezgqxjpcrin',
    runCommand: async (args) => {
      calls.push(args);
      if (args.includes('secrets')) return secretsListOutput([{ name: VAULT_TOKEN_PEPPER_NAME, value: 'synthetic-secret' }]);
      return JSON.stringify([checks]);
    },
  });

  assert.equal(result.pepperPresent, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['exec', 'supabase', 'secrets', 'list', '--project-ref', 'ciyoandzjezgqxjpcrin', '--output-format', 'json']);
  assert.deepEqual(calls[1], ['exec', 'supabase', 'db', 'query', '--linked', '--project-ref', 'ciyoandzjezgqxjpcrin', '--output-format', 'json', VAULT_READINESS_SQL]);
  assert.match(VAULT_READINESS_SQL, /has_function_privilege/);
  assert.match(VAULT_READINESS_SQL, /qnotes_vault_reveal_secrets\(uuid,jsonb,uuid,text,uuid,text\)/);
  assert.doesNotMatch(VAULT_READINESS_SQL, /\b(insert|update|delete|create|drop|alter)\b/i);
});

test('suppresses command failures instead of forwarding command output', async () => {
  await assert.rejects(
    () => verifyVaultReadiness({
      projectId: 'ciyoandzjezgqxjpcrin',
      runCommand: async () => { throw new Error('synthetic-secret-or-database-row'); },
    }),
    (error) => error.message.includes('Supabase secrets list was unavailable or failed') && !error.message.includes('synthetic-secret-or-database-row'),
  );
});

test('fails clearly when the linked readiness query is unavailable', async () => {
  let calls = 0;
  await assert.rejects(
    () => verifyVaultReadiness({
      projectId: 'ciyoandzjezgqxjpcrin',
      runCommand: async (args) => {
        calls += 1;
        if (args.includes('secrets')) return secretsListOutput([{ name: VAULT_TOKEN_PEPPER_NAME }]);
        throw new Error('synthetic-database-row-or-secret');
      },
    }),
    (error) => error.message.includes('Supabase linked database readiness query was unavailable or failed') && !error.message.includes('synthetic-database-row-or-secret'),
  );
  assert.equal(calls, 2);
});
