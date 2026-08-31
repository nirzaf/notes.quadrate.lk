import { clearApplicationData } from './helpers';

export default async function globalSetup(): Promise<void> {
  await clearApplicationData();
  console.log('E2E global setup verified local users and cleared application data.');
}
