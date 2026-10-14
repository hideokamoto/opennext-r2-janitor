// Build IDs end up as a single path segment of the cache key, so anything that could
// change the key structure (slashes, whitespace) is rejected outright.
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export function isValidBuildId(value: unknown): value is string {
  return (
    typeof value === 'string' && BUILD_ID_PATTERN.test(value) && value !== '.' && value !== '..'
  )
}

interface AssetsLike {
  fetch(input: string): Promise<{ ok: boolean; text(): Promise<string> }>
}

/**
 * Resolves the build ID from inside the OpenNext worker (for example in a `scheduled` handler).
 *
 * 1. `process.env.OPEN_NEXT_BUILD_ID` — the exact value OpenNext uses for cache keys
 *    (`deploymentId ?? BUILD_ID`). OpenNext sets it when its server bundle loads.
 * 2. The `BUILD_ID` file that OpenNext emits into the static assets, read through the
 *    `ASSETS` binding. This is Next's build ID and does not reflect `deploymentId`.
 *
 * Returns `null` when neither yields a valid ID.
 */
export async function resolveBuildIdFromWorker(
  options: { assets?: AssetsLike } = {},
): Promise<string | null> {
  // Read through a cast instead of a global declaration so consumers' @types/node is unaffected.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const fromEnv = proc?.env?.OPEN_NEXT_BUILD_ID
  if (isValidBuildId(fromEnv)) return fromEnv

  if (options.assets) {
    try {
      // The host is ignored by the ASSETS binding; only the path matters.
      const res = await options.assets.fetch('https://assets.local/BUILD_ID')
      if (res.ok) {
        const text = (await res.text()).trim()
        if (isValidBuildId(text)) return text
      }
    } catch {
      // An unreadable asset is the same as an unavailable build ID.
    }
  }
  return null
}

/**
 * Reads the build ID a deployed OpenNext site serves at `/BUILD_ID`.
 * Intended for a standalone janitor worker that cleans buckets of other sites.
 * Returns `null` on a network error, a non-2xx response or an unexpected body.
 */
export async function fetchBuildIdFromSite(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url = new URL('/BUILD_ID', siteUrl)
  try {
    const res = await fetchImpl(url.toString(), { redirect: 'follow' })
    if (!res.ok) return null
    const text = (await res.text()).trim()
    return isValidBuildId(text) ? text : null
  } catch {
    return null
  }
}
