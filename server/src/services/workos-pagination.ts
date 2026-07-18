interface WorkOSPage<T> {
  data: T[];
  listMetadata?: {
    after?: string | null;
  };
}

/** Collect every page from a cursor-paginated WorkOS list endpoint. */
export async function collectWorkOSPages<T>(
  fetchPage: (after: string | undefined) => Promise<WorkOSPage<T>>
): Promise<T[]> {
  const results: T[] = [];
  let after: string | undefined;

  do {
    const page = await fetchPage(after);
    results.push(...page.data);
    after = page.listMetadata?.after ?? undefined;
  } while (after);

  return results;
}
