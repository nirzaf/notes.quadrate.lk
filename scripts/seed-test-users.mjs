import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = JSON.parse(await readFile(join(root, '.tmp/local-env.json'), 'utf8'));
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(local.supabaseUrl)) {
  throw new Error('Refusing to create test users outside the local Supabase project.');
}

const users = [
  { email: 'owner@qnotes.local', password: 'Qnotes-Test-Owner-2026!' },
  { email: 'other@qnotes.local', password: 'Qnotes-Test-Other-2026!' },
];
const adminHeaders = { apikey: local.serviceRoleKey, Authorization: `Bearer ${local.serviceRoleKey}`, 'Content-Type': 'application/json' };

async function request(path, init = {}) {
  const response = await fetch(`${local.supabaseUrl}${path}`, { ...init, headers: { ...adminHeaders, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}: ${body?.msg ?? body?.message ?? 'unknown error'}`);
  return body;
}

const listing = await request('/auth/v1/admin/users?page=1&per_page=100');
for (const user of users) {
  let existing = listing.users?.find((candidate) => candidate.email === user.email);
  if (existing) {
    const signIn = await fetch(`${local.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: local.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    if (!signIn.ok) {
      await request(`/auth/v1/admin/users/${existing.id}`, { method: 'DELETE' });
      existing = null;
    }
  }
  if (!existing) {
    await request('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: user.email, password: user.password, email_confirm: true }) });
  } else if (!existing.email_confirmed_at) {
    await request(`/auth/v1/admin/users/${existing.id}`, { method: 'PUT', body: JSON.stringify({ email_confirm: true }) });
  }
}
console.log(`Verified ${users.length} local test users.`);
