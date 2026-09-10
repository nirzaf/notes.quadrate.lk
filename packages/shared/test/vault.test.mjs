import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VAULT_BATCH_BYTES,
  MAX_VAULT_BATCH_REVEAL,
  MAX_VAULT_SECRET_BYTES,
  isVaultAgentToken,
  normalizeVaultSecretName,
  validateCreateVaultProjectInput,
  validateCreateVaultSecretInput,
  validateCreateVaultAgentTokenInput,
  validateReplaceVaultAgentGrantsInput,
  validateRevealVaultSecretsInput,
} from '../dist/index.js';

const projectId = '550e8400-e29b-41d4-a716-446655440000';
const environmentId = '660e8400-e29b-41d4-a716-446655440000';
const mutationId = '770e8400-e29b-41d4-a716-446655440000';

test('Vault contracts enforce bounded names, secret bytes, and exact qvt credentials', () => {
  assert.equal(isVaultAgentToken(`qvt_${'A'.repeat(43)}`), true);
  assert.equal(isVaultAgentToken(`qvt_${'A'.repeat(42)}`), false);
  assert.equal(isVaultAgentToken(`qnt_${'A'.repeat(43)}`), false);
  assert.equal(normalizeVaultSecretName(' CLOUDFLARE_API_TOKEN '), 'CLOUDFLARE_API_TOKEN');
  assert.throws(() => normalizeVaultSecretName('/etc/passwd'), /secret name/);
  assert.equal(MAX_VAULT_SECRET_BYTES, 65_536);
  assert.equal(MAX_VAULT_BATCH_REVEAL, 20);
  assert.equal(MAX_VAULT_BATCH_BYTES, 262_144);
});

test('Vault validators normalize safe metadata and preserve secret values only in secret inputs', () => {
  assert.deepEqual(validateCreateVaultProjectInput({ slug: 'pearl-blanc', name: ' Pearl Blanc ', description: 'Deploy metadata' }), {
    slug: 'pearl-blanc', name: 'Pearl Blanc', description: 'Deploy metadata',
  });
  const secret = validateCreateVaultSecretInput({ projectId, environmentId, name: 'CLOUDFLARE_API_TOKEN', value: 'local-only-secret', mutationId });
  assert.deepEqual(secret, { projectId, environmentId, name: 'CLOUDFLARE_API_TOKEN', value: 'local-only-secret', mutationId });
  assert.deepEqual(validateCreateVaultSecretInput({ projectId, environmentId, name: ' KEY ', description: ' description ', value: 'local-only-secret', mutationId }), {
    projectId, environmentId, name: 'KEY', description: 'description', value: 'local-only-secret', mutationId,
  });
  assert.throws(() => validateCreateVaultSecretInput({ projectId, environmentId, name: 'KEY', value: '😀'.repeat(32_768), mutationId }), /too large/);
});

test('Vault batch reveal requires an explicit bounded selector list and purpose', () => {
  const input = validateRevealVaultSecretsInput({
    secrets: [{ project: 'pearl-blanc', environment: 'production', name: 'CLOUDFLARE_API_TOKEN' }],
    purpose: 'Deploy Pearl Blanc production',
  });
  assert.deepEqual(input.secrets[0], { project: 'pearl-blanc', environment: 'production', name: 'CLOUDFLARE_API_TOKEN' });
  assert.throws(() => validateRevealVaultSecretsInput({ secrets: [], purpose: 'x' }), /at least one/);
  assert.throws(() => validateRevealVaultSecretsInput({ secrets: Array.from({ length: 21 }, () => ({ project: 'p', environment: 'e', name: 'K' })), purpose: 'x' }), /at most 20/);
});

test('Vault token creation requires a grant while replacement can clear every grant', () => {
  const grant = { projectId, environmentId: null, secretId: null, action: 'metadata:read' };
  assert.throws(() => validateCreateVaultAgentTokenInput({ name: 'empty', expiresAt: null, grants: [] }), /future ISO date/);
  assert.throws(() => validateCreateVaultAgentTokenInput({ name: 'empty', expiresAt: new Date(Date.now() + 60_000).toISOString(), grants: [] }), /1 to/);
  assert.equal(validateCreateVaultAgentTokenInput({ name: ' deploy ', expiresAt: new Date(Date.now() + 60_000).toISOString(), grants: [grant] }).name, 'deploy');
  assert.deepEqual(validateReplaceVaultAgentGrantsInput({ grants: [grant] }), { grants: [grant] });
  assert.deepEqual(validateReplaceVaultAgentGrantsInput({ grants: [] }), { grants: [] });
});
