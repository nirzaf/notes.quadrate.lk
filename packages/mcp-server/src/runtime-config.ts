export function resolveVaultBaseUrl(qnotesUrl: string, qvaultUrl: string | undefined): string {
  if (qvaultUrl?.trim()) {
    throw new Error('QVAULT_URL is not supported. Vault requests must use QNOTES_URL.');
  }
  return qnotesUrl;
}
