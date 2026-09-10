import assert from 'node:assert/strict';
import { buildVaultAuditFailureRow, recordVaultAgentAccessDenied, recordVaultAuditFailure } from './vault-audit.ts';
import type { VaultAuthContext } from './vault-auth.ts';

const auth: VaultAuthContext = {
  userId: '550e8400-e29b-41d4-a716-446655440000',
  authKind: 'vault-agent',
  tokenId: '660e8400-e29b-41d4-a716-446655440000',
};
const resource = {
  ownerId: auth.userId,
  projectId: '770e8400-e29b-41d4-a716-446655440000',
  environmentId: '880e8400-e29b-41d4-a716-446655440000',
  secretId: '990e8400-e29b-41d4-a716-446655440000',
};

function fakeClient(insert: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return { rpc: (name: string, args: Record<string, unknown>) => insert(name, args).then(() => ({ error: null })) };
}

Deno.test('Vault failure audit payload contains only safe actor and resource metadata', () => {
  assert.deepEqual(buildVaultAuditFailureRow(auth, 'secret:reveal', resource, 'access_denied', {
    requestId: 'aa0e8400-e29b-41d4-a716-446655440000',
    purpose: 'deploy without returning a secret value',
  }), {
    owner_id: auth.userId,
    actor_kind: 'vault_agent',
    actor_token_id: auth.tokenId,
    action: 'secret:reveal',
    project_id: resource.projectId,
    environment_id: resource.environmentId,
    secret_id: resource.secretId,
    purpose: 'deploy without returning a secret value',
    success: false,
    result_code: 'access_denied',
    request_id: 'aa0e8400-e29b-41d4-a716-446655440000',
  });
});

Deno.test('Vault failure audit is best effort and records agent denials only for agents', async () => {
  const rows: Record<string, unknown>[] = [];
  const client = fakeClient(async (name, args) => { assert.equal(name, 'qnotes_vault_append_audit_event'); rows.push(args); });
  await recordVaultAgentAccessDenied(auth, 'secret:reveal', resource, { purpose: 'denied reveal' }, client);
  await recordVaultAgentAccessDenied({ userId: auth.userId, authKind: 'jwt' }, 'secret:reveal', resource, {}, client);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.p_result_code, 'access_denied');
  assert.equal(rows[0]?.p_actor_token_id, auth.tokenId);
  assert(!Object.hasOwn(rows[0] ?? {}, 'token_hash'));
  assert(!Object.hasOwn(rows[0] ?? {}, 'value'));

  await recordVaultAuditFailure(auth, 'secret:write', resource, 'version_conflict', {}, fakeClient(async () => { throw new Error('audit storage unavailable'); }));
});
