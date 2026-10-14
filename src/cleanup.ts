import { isValidBuildId } from './buildId.js'
import { loadState, saveState } from './state.js'
import type {
  AbortReason,
  CleanupOptions,
  CleanupReport,
  JanitorState,
  R2BucketLike,
  R2ListOptionsLike,
  R2ObjectsLike,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
// R2's delete() accepts at most 1000 keys per call.
const DELETE_BATCH = 1000

class BudgetExhausted extends Error {}

/** Counts R2 calls against the per-run subrequest budget. */
class Budget {
  used = 0
  constructor(private readonly limit: number) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.used >= this.limit) throw new BudgetExhausted()
    this.used++
    return fn()
  }
}

/**
 * OpenNext stores entries at `<prefix>/<buildId>/<hash>.<cacheType>` (see `computeCacheKey` in
 * `@opennextjs/cloudflare`). Normalise the prefix the same way it does, with a trailing slash.
 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
  return trimmed === '' ? '' : `${trimmed}/`
}

/**
 * Deletes incremental cache entries of builds that are no longer served.
 *
 * Every build ID found under the prefix is judged on its own, so a run that hits the
 * subrequest budget can stop anywhere and the next run resumes from there:
 * - the current build is always kept;
 * - a build seen as current within `keepDays` (from the state object) is kept;
 * - a build with any object uploaded within `keepDays` is kept;
 * - anything else is deleted.
 *
 * Nothing is deleted when the layout under the prefix is not what OpenNext produces, or when
 * the current build ID does not exist in the bucket (a sign of a wrong prefix or build ID).
 */
export async function cleanupOpenNextR2Cache(options: CleanupOptions): Promise<CleanupReport> {
  const prefix = normalizePrefix(options.prefix ?? 'incremental-cache')
  const keepDays = options.keepDays ?? 14
  const dryRun = options.dryRun ?? true
  const stateKey =
    options.stateKey === undefined ? 'opennext-r2-janitor/state.json' : options.stateKey
  const maxSubrequests = options.maxSubrequests ?? 40
  const now = options.now ?? new Date()
  const { bucket, currentBuildId } = options

  if (prefix === '') throw new Error('prefix must not be empty')
  if (!(keepDays >= 0)) throw new Error('keepDays must be a non-negative number')
  if (stateKey?.startsWith(prefix)) {
    throw new Error(`stateKey "${stateKey}" must not be inside the cache prefix "${prefix}"`)
  }
  // Reserve one subrequest for writing the state at the end.
  const reserved = stateKey === null ? 0 : 1
  if (maxSubrequests < reserved + 2) {
    throw new Error(`maxSubrequests must be at least ${reserved + 2}`)
  }

  const budget = new Budget(maxSubrequests - reserved)
  const report: CleanupReport = {
    dryRun,
    currentBuildId,
    prefix,
    buildIds: 0,
    kept: [],
    deleted: [],
    pending: false,
    subrequests: 0,
  }
  const abort = (reason: AbortReason, detail: string): CleanupReport => {
    report.aborted = { reason, detail }
    report.subrequests = budget.used
    return report
  }

  if (!isValidBuildId(currentBuildId)) {
    return abort('invalid-build-id', `"${String(currentBuildId)}" is not a valid build ID`)
  }

  let state: JanitorState
  let buildIds: string[]
  try {
    state = stateKey === null ? emptyState() : await budget.call(() => loadState(bucket, stateKey))
    const listing = await listBuildIds(bucket, budget, prefix)
    if (listing.strayKey !== undefined) {
      return abort(
        'unexpected-layout',
        `found "${listing.strayKey}" directly under "${prefix}"; expected only <buildId>/ folders`,
      )
    }
    buildIds = listing.buildIds
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e
    // Not even the build list fit in the budget; nothing was judged, so nothing changes.
    report.pending = true
    report.subrequests = budget.used
    return report
  }

  report.buildIds = buildIds.length
  if (!buildIds.includes(currentBuildId)) {
    return abort(
      'current-build-not-found',
      `no "${prefix}${currentBuildId}/" in the bucket; check the prefix and the build ID source`,
    )
  }

  const cutoff = now.getTime() - keepDays * DAY_MS
  state.lastSeenCurrent[currentBuildId] = now.toISOString()
  // Forget builds that no longer exist so the state does not grow without bound.
  for (const id of Object.keys(state.lastSeenCurrent)) {
    if (!buildIds.includes(id)) delete state.lastSeenCurrent[id]
  }

  let lastCompleted: string | undefined
  try {
    for (const buildId of rotate(buildIds, state.resumeAfter)) {
      if (buildId === currentBuildId) {
        report.kept.push({ buildId, reason: 'current' })
      } else if (Date.parse(state.lastSeenCurrent[buildId] ?? '') >= cutoff) {
        report.kept.push({ buildId, reason: 'recently-current' })
      } else {
        const keys = await collectKeysIfStale(bucket, budget, `${prefix}${buildId}/`, cutoff)
        if (keys === null) {
          report.kept.push({ buildId, reason: 'recently-written' })
        } else {
          if (!dryRun) {
            for (let i = 0; i < keys.length; i += DELETE_BATCH) {
              const batch = keys.slice(i, i + DELETE_BATCH)
              await budget.call(() => bucket.delete(batch))
            }
          }
          report.deleted.push({ buildId, objects: keys.length })
        }
      }
      lastCompleted = buildId
    }
    state.resumeAfter = undefined
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e
    // Resume after the last fully handled build; a partly deleted one is simply re-examined.
    report.pending = true
    state.resumeAfter = lastCompleted ?? state.resumeAfter
  }

  if (stateKey !== null) {
    budget.used++ // the reserved subrequest
    await saveState(bucket, stateKey, state)
  }
  report.subrequests = budget.used
  return report
}

function emptyState(): JanitorState {
  return { version: 1, lastSeenCurrent: {} }
}

async function listAll(
  bucket: R2BucketLike,
  budget: Budget,
  options: R2ListOptionsLike,
  onPage: (page: R2ObjectsLike) => boolean | undefined,
): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await budget.call(() => bucket.list({ ...options, cursor, limit: 1000 }))
    if (onPage(page) === false) return
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

async function listBuildIds(
  bucket: R2BucketLike,
  budget: Budget,
  prefix: string,
): Promise<{ buildIds: string[]; strayKey?: string }> {
  const buildIds: string[] = []
  let strayKey: string | undefined
  await listAll(bucket, budget, { prefix, delimiter: '/' }, (page) => {
    if (page.objects.length > 0) {
      strayKey = page.objects[0]?.key
      return false
    }
    for (const p of page.delimitedPrefixes) buildIds.push(p.slice(prefix.length).replace(/\/$/, ''))
    return true
  })
  return { buildIds: buildIds.sort(), strayKey }
}

/** Returns every key under `folder`, or `null` as soon as one was uploaded at or after `cutoff`. */
async function collectKeysIfStale(
  bucket: R2BucketLike,
  budget: Budget,
  folder: string,
  cutoff: number,
): Promise<string[] | null> {
  const keys: string[] = []
  let recent = false
  await listAll(bucket, budget, { prefix: folder }, (page) => {
    for (const obj of page.objects) {
      if (obj.uploaded.getTime() >= cutoff) {
        recent = true
        return false
      }
      keys.push(obj.key)
    }
    return true
  })
  return recent ? null : keys
}

/** Starts the iteration after `resumeAfter`, wrapping around, so successive runs make progress. */
function rotate(sortedIds: string[], resumeAfter: string | undefined): string[] {
  if (resumeAfter === undefined) return sortedIds
  const start = sortedIds.findIndex((id) => id > resumeAfter)
  if (start <= 0) return sortedIds
  return [...sortedIds.slice(start), ...sortedIds.slice(0, start)]
}
