export function resolveVaultBaseUrl(qnotesUrl: string, qvaultUrl: string | undefined): string {
  if (qvaultUrl?.trim()) {
    throw new Error('QVAULT_URL is not supported. Vault requests must use QNOTES_URL.');
  }
  return qnotesUrl;
}

export function resolveVaultMcpProfile(value: string | undefined): 'metadata' | 'reveal' | 'write' {
  if (value === undefined || value === 'metadata') return 'metadata';
  if (value === 'reveal' || value === 'write') return value;
  throw new Error('Unsupported QVAULT_MCP_PROFILE. Use metadata, reveal, or write.');
}
