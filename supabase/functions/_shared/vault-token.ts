import { hashVaultApprovalRequest, isVaultAgentToken } from '@qnotes/shared';

const VAULT_TOKEN_PREFIX = 'qvt_';
const VAULT_APPROVAL_PREFIX = 'qva_';

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pepper(): string {
  const value = Deno.env.get('QNOTES_VAULT_TOKEN_PEPPER');
  if (!value) throw new Error('QNOTES_VAULT_TOKEN_PEPPER is not configured.');
  return value;
}

async function hmacWithPepper(domain: string, value: string, pepperValue: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepperValue), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${domain}\0${value}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(domain: string, value: string): Promise<string> {
  return hmacWithPepper(domain, value, pepper());
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function generateVaultAgentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${VAULT_TOKEN_PREFIX}${base64Url(bytes)}`;
}

export function generateVaultApprovalToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${VAULT_APPROVAL_PREFIX}${base64Url(bytes)}`;
}

export { isVaultAgentToken };

export function hashVaultAgentToken(token: string): Promise<string> {
  return hmac('qnotes-vault-agent-token-v1', token);
}

export function hashVaultMutation(request: unknown): Promise<string> {
  return hmac('qnotes-vault-mutation-v1', stableJson(request));
}

export async function hashVaultMutationCandidates(request: unknown): Promise<string[]> {
  const value = stableJson(request);
  const current = pepper();
  const previous = Deno.env.get('QNOTES_VAULT_MUTATION_PEPPER_PREVIOUS')?.trim();
  const hashes = [await hmacWithPepper('qnotes-vault-mutation-v1', value, current)];
  if (previous && previous !== current) hashes.push(await hmacWithPepper('qnotes-vault-mutation-v1', value, previous));
  return hashes;
}

export function hashVaultApprovalToken(token: string): Promise<string> {
  return hashVaultApprovalRequest({ domain: 'qnotes-vault-approval-v1', token });
}
