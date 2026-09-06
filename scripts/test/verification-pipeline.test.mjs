import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverEdgeTestFiles, denoInvocation, edgeTestArguments } from '../test-edge.mjs';
import { LOCAL_VERIFY_STAGES, assertLocalUrl, assertMatchingTarget, runStages } from '../verify-local.mjs';

test('discovers only the Edge test files and builds a non-shell Deno command', async () => {
  const files = await discoverEdgeTestFiles();
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.startsWith('supabase/functions/') && file.endsWith('.test.ts')));
  assert.ok(files.includes('supabase/functions/_shared/auth-telemetry.test.ts'));
  assert.ok(files.includes('supabase/functions/embedding-worker/adapter.test.ts'));
  assert.ok(files.includes('supabase/functions/embedding-worker/worker-budget.test.ts'));

  const args = edgeTestArguments(files);
  assert.deepEqual(args.slice(0, 4), ['test', '--no-lock', '--allow-env=QNOTES_TOKEN_PEPPER', '--import-map=supabase/functions/deno.json']);
  assert.equal(args.some((arg) => arg.includes('*')), false);
  assert.equal(args.includes('--allow-all'), false);
  assert.deepEqual(args.slice(4), files);
});

test('uses the exact pinned Deno fallback when native Deno is unavailable', () => {
  assert.deepEqual(denoInvocation(true, ['test']), { command: 'deno', args: ['test'] });
  assert.deepEqual(denoInvocation(false, ['test']), { command: 'pnpm', args: ['dlx', '--yes', 'deno@2.9.6', 'test'] });
});

test('accepts only credential-free loopback targets', () => {
  assert.equal(assertLocalUrl('http://127.0.0.1:54321/functions/v1/qnotes-api', 'API'), 'http://127.0.0.1:54321/functions/v1/qnotes-api');
  assert.equal(assertLocalUrl('http://localhost:54321', 'Supabase'), 'http://localhost:54321');
  assert.throws(() => assertLocalUrl('https://127.0.0.1:54321', 'API'), /http/);
  assert.throws(() => assertLocalUrl('http://user:secret@127.0.0.1:54321', 'API'), /credentials/);
  assert.throws(() => assertLocalUrl('http://example.com', 'API'), /localhost or 127\.0\.0\.1/);
});

test('rejects mismatched local targets without exposing their values', () => {
  assert.doesNotThrow(() => assertMatchingTarget('http://localhost:54321', 'http://localhost:54321/', 'Supabase URL'));
  assert.throws(() => assertMatchingTarget('http://localhost:54321', 'http://localhost:54322', 'Supabase URL'), /does not match/);
});

test('runs verification stages in order and stops at the first failure', async () => {
  assert.deepEqual(LOCAL_VERIFY_STAGES.map((stage) => stage.name), [
    'typecheck',
    'unit tests',
    'Edge tests',
    'build',
    'generated Edge parity',
    'database tests',
    'navigation E2E',
  ]);
  assert.deepEqual(LOCAL_VERIFY_STAGES.at(-1).args, ['exec', 'playwright', 'test', 'tests/e2e/navigation.spec.ts', '--project=chromium']);

  const calls = [];
  await assert.rejects(
    () => runStages(LOCAL_VERIFY_STAGES.slice(0, 3), async (command, args) => {
      calls.push([command, args]);
      return calls.length === 2 ? 9 : 0;
    }),
    /later stages were not run/,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(([command, args]) => [command, args[0], args[1]]), [
    ['pnpm', 'run', 'typecheck'],
    ['pnpm', 'run', 'test:unit'],
  ]);
});
