/** Cloudflare D1's documented maximum number of bindings in one query. */
export const MAX_D1_BOUND_PARAMETERS = 100;

/**
 * Deduplicate values and split them into the largest D1-safe query chunks.
 *
 * Callers reserve bindings used by tenant predicates or other fixed clauses.
 * Keeping chunks near the platform maximum avoids turning one oversized query
 * into enough small queries to threaten the per-invocation query budget.
 */
export function boundedInChunks<T>(
  values: readonly T[],
  fixedParameters = 0,
): T[][] {
  if (
    !Number.isSafeInteger(fixedParameters) ||
    fixedParameters < 0 ||
    fixedParameters >= MAX_D1_BOUND_PARAMETERS
  ) {
    throw new RangeError("fixedParameters must leave room for an IN-list value");
  }

  const unique = [...new Set(values)];
  const size = MAX_D1_BOUND_PARAMETERS - fixedParameters;
  const chunks: T[][] = [];
  for (let start = 0; start < unique.length; start += size) {
    chunks.push(unique.slice(start, start + size));
  }
  return chunks;
}
