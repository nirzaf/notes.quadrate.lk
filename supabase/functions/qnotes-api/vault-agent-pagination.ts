export const VAULT_AGENT_GRANT_PAGE_SIZE = 500;

export async function fetchAllRangePages<T>(
  fetchPage: (from: number, to: number) => Promise<readonly T[]>,
  pageSize = VAULT_AGENT_GRANT_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive safe integer.');
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
