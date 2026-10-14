import { isValidBuildId } from './buildId.js'
import type { JanitorState, R2BucketLike } from './types.js'

/** Reads the state object. A missing or unreadable state starts fresh instead of failing the run. */
export async function loadState(bucket: R2BucketLike, key: string): Promise<JanitorState> {
  const obj = await bucket.get(key)
  if (!obj) return { version: 1, lastSeenCurrent: {} }
  try {
    const parsed = JSON.parse(await obj.text()) as Partial<JanitorState>
    const lastSeenCurrent: Record<string, string> = {}
    for (const [id, iso] of Object.entries(parsed.lastSeenCurrent ?? {})) {
      if (isValidBuildId(id) && typeof iso === 'string' && !Number.isNaN(Date.parse(iso))) {
        lastSeenCurrent[id] = iso
      }
    }
    const resumeAfter = isValidBuildId(parsed.resumeAfter) ? parsed.resumeAfter : undefined
    return { version: 1, lastSeenCurrent, resumeAfter }
  } catch {
    return { version: 1, lastSeenCurrent: {} }
  }
}

export async function saveState(
  bucket: R2BucketLike,
  key: string,
  state: JanitorState,
): Promise<void> {
  await bucket.put(key, JSON.stringify(state))
}
