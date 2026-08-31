import { test as base, expect } from '@playwright/test';
import { clearApplicationData } from './helpers';

export const test = base;
test.beforeEach(async () => {
  await clearApplicationData();
});

export { expect };
