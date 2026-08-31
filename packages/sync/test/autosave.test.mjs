import test from 'node:test';
import assert from 'node:assert/strict';
import { AutosaveCoordinator } from '../dist/index.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('debounces scheduled saves', async () => {
  const saved = [];
  const coordinator = new AutosaveCoordinator({ delayMs: 15, save: async (value) => { saved.push(value); }, onError: () => assert.fail('unexpected error') });
  coordinator.schedule('a');
  coordinator.schedule('b');
  await wait(35);
  assert.deepEqual(saved, ['b']);
  coordinator.dispose();
});

test('serializes in-flight saves and coalesces the latest value', async () => {
  const saved = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = new AutosaveCoordinator({ delayMs: 0, save: async (value) => { saved.push(value); if (value === 'a') await gate; }, onError: () => assert.fail('unexpected error') });
  coordinator.schedule('a');
  await wait(5);
  coordinator.schedule('b');
  coordinator.schedule('c');
  const flushed = coordinator.flush();
  await wait(5);
  assert.deepEqual(saved, ['a']);
  release();
  await flushed;
  assert.deepEqual(saved, ['a', 'c']);
  coordinator.dispose();
});

test('flush saves immediately and dispose cancels pending work', async () => {
  const flushedValues = [];
  const coordinator = new AutosaveCoordinator({ delayMs: 100, save: async (value) => { flushedValues.push(value); }, onError: () => assert.fail('unexpected error') });
  coordinator.schedule('flush-me');
  await coordinator.flush();
  assert.deepEqual(flushedValues, ['flush-me']);
  coordinator.schedule('discard-me');
  coordinator.dispose();
  await wait(120);
  assert.deepEqual(flushedValues, ['flush-me']);
});

test('reports one error per failed save attempt', async () => {
  const errors = [];
  const coordinator = new AutosaveCoordinator({ delayMs: 0, save: async () => { throw new Error('failed'); }, onError: (error) => errors.push(error.message) });
  coordinator.schedule('bad');
  await coordinator.flush();
  assert.deepEqual(errors, ['failed']);
  coordinator.dispose();
});
