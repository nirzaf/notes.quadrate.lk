import { assertLocalE2ETargets, clearApplicationData } from './helpers';

export default async function globalSetup(): Promise<void> {
  assertLocalE2ETargets();
  await clearApplicationData();
  console.log('E2E global setup verified local targets and cleared only the dedicated local test users.');
}
