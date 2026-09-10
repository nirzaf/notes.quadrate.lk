import test from 'node:test';
import assert from 'node:assert/strict';
import { authPrincipal, canAccessNotebook, requireCursorPolicy, scopedSearchPlan, type ScopedSearchPlan } from './notebook-access.ts';
import type { AuthContext } from './auth.ts';

const auth: AuthContext = {
  userId: '00000000-0000-4000-8000-000000000001',
  authKind: 'personal',
  scopes: ['notes:read', 'search:read'],
  tokenId: '00000000-0000-4000-8000-000000000002',
  accessMode: 'notebooks',
  notebookIds: ['00000000-0000-4000-8000-000000000003'],
  allowUnfiled: false,
  policyRevision: 2,
};

test('notebook grants distinguish filed and unfiled notes', () => {
  assert.equal(canAccessNotebook(auth, '00000000-0000-4000-8000-000000000003'), true);
  assert.equal(canAccessNotebook(auth, '00000000-0000-4000-8000-000000000004'), false);
  assert.equal(canAccessNotebook(auth, null), false);
});

test('search scope is intersected before retrieval and caller filters are removed', () => {
  const plan: ScopedSearchPlan = scopedSearchPlan(auth, {
    notebookIds: ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'],
    tags: ['operations'],
    unfiled: false,
  });
  assert.deepEqual(plan.notebookIds, ['00000000-0000-4000-8000-000000000003']);
  assert.equal(plan.allowUnfiled, false);
  assert.deepEqual(plan.filters, { tags: ['operations'] });
  assert.equal(plan.empty, false);
  assert.equal(scopedSearchPlan(auth, { notebookIds: ['00000000-0000-4000-8000-000000000003'] }).allowUnfiled, false);
  const notebookAndUnfiled = scopedSearchPlan(auth, { notebookIds: ['00000000-0000-4000-8000-000000000003'], unfiled: true });
  assert.deepEqual(notebookAndUnfiled.notebookIds, ['00000000-0000-4000-8000-000000000003']);
  assert.equal(notebookAndUnfiled.allowUnfiled, false);
  assert.equal(notebookAndUnfiled.empty, false);
  assert.equal(scopedSearchPlan(auth, { unfiled: true }).empty, true);
});

test('cursor policy uses the namespaced principal and current revision', () => {
  const accountWide = { ...auth, accessMode: 'account' as const, notebookIds: [], allowUnfiled: true };
  assert.equal(authPrincipal(auth), 'personal:00000000-0000-4000-8000-000000000002');
  assert.doesNotThrow(() => requireCursorPolicy(auth, authPrincipal(auth), 2));
  assert.doesNotThrow(() => requireCursorPolicy(accountWide, undefined, undefined));
  assert.throws(() => requireCursorPolicy(auth, auth.userId, 2), { code: 'VALIDATION_ERROR' });
  assert.throws(() => requireCursorPolicy(auth, authPrincipal(auth), 1), { code: 'VALIDATION_ERROR' });
  assert.throws(() => requireCursorPolicy(auth, undefined, undefined), { code: 'VALIDATION_ERROR' });
});
