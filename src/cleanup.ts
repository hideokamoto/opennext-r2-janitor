import { isValidBuildId } from './buildId.js'
import { InvalidStateError, loadState, saveState } from './state.js'
import type {
  AbortReason,
  BuildProgress,
  CleanupOptions,
  CleanupReport,
  JanitorState,
  R2BucketLike,
  R2ListOptionsLike,
  R2ObjectsLike,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
// R2's list() returns and delete() accepts at most 1000 keys per call.
const PAGE = 1000

// Bookkeeping per run: build list (1) and, with a state object, its read (1) and write (1);
// plus one delete round: list (1) and delete (1).
const MIN_SUBREQUESTS_WITHOUT_STATE = 3
const MIN_SUBREQUESTS_WITH_STATE = 5

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
 * Every build ID found under the prefix is judged on its own:
 * - the current build is always kept;
 * - a build seen as current within `keepDays` (from the state object) is kept;
 * - a build with any object uploaded within `keepDays` is kept, found by scanning its whole folder
 *   before anything in it is deleted;
 * - anything else is deleted.
 *
 * A run stops when it has used its subrequest budget and the next run continues from the saved
 * progress, so a build folder of any size is eventually handled.
 *
 * Nothing is deleted when the layout under the prefix is not what OpenNext produces, when the
 * current build ID does not exist in the bucket (a sign of a wrong prefix or build ID), or when the
 * state object exists but cannot be read.
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
  // One subrequest is reserved for writing the state at the end. Below the minimum, a run spends
  // everything on bookkeeping and a delete round (one list plus one delete) never fits, so a big
  // build would never make progress.
  const reserved = stateKey === null ? 0 : 1
  const minimum = stateKey === null ? MIN_SUBREQUESTS_WITHOUT_STATE : MIN_SUBREQUESTS_WITH_STATE
  if (maxSubrequests < minimum) {
    throw new Error(
      `maxSubrequests must be at least ${minimum}${stateKey === null ? '' : ' with a state object'}`,
    )
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
    state =
      stateKey === null
        ? { version: 1, lastSeenCurrent: {} }
        : await budget.call(() => loadState(bucket, stateKey))
    const listing = await listBuildIds(bucket, budget, prefix)
    if (listing.strayKey !== undefined) {
      return abort(
        'unexpected-layout',
        `found "${listing.strayKey}" directly under "${prefix}"; expected only <buildId>/ folders`,
      )
    }
    buildIds = listing.buildIds
  } catch (e) {
    if (e instanceof InvalidStateError) {
      return abort('unreadable-state', `${e.message}; delete the object to start over`)
    }
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
  if (state.progress && !buildIds.includes(state.progress.buildId)) state.progress = undefined

  let lastCompleted: string | undefined
  try {
    for (const buildId of visitOrder(buildIds, state)) {
      if (buildId === currentBuildId) {
        report.kept.push({ buildId, reason: 'current' })
        dropProgress(state, buildId)
      } else if (Date.parse(state.lastSeenCurrent[buildId] ?? '') >= cutoff) {
        report.kept.push({ buildId, reason: 'recently-current' })
        dropProgress(state, buildId)
      } else {
        await sweepBuild({ bucket, budget, prefix, cutoff, dryRun, state, report }, buildId)
      }
      lastCompleted = buildId
    }
    state.resumeAfter = undefined
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      report.pending = true
      // Resume after the last fully handled build; the unfinished one is picked up from its progress.
      state.resumeAfter = lastCompleted ?? state.resumeAfter
      if (state.progress) {
        const { buildId, phase, objects } = state.progress
        report.partial = { buildId, phase, objects }
      }
    } else {
      // A saved cursor that no longer works would fail every run; start the build over next time.
      if (stateKey !== null && state.progress?.cursor !== undefined) {
        state.progress = undefined
        await saveState(bucket, stateKey, state)
      }
      throw e
    }
  }

  if (stateKey !== null) {
    budget.used++ // the reserved subrequest
    await saveState(bucket, stateKey, state)
  }
  report.subrequests = budget.used
  return report
}

interface SweepContext {
  bucket: R2BucketLike
  budget: Budget
  prefix: string
  cutoff: number
  dryRun: boolean
  state: JanitorState
  report: CleanupReport
}

/**
 * Scans one stale-looking build, then deletes it. The scan covers the whole folder first so that a
 * build with a single recent object is left untouched instead of being half emptied. The delete
 * phase checks every page again, so an object written in the meantime also stops it.
 */
async function sweepBuild(ctx: SweepContext, buildId: string): Promise<void> {
  const { bucket, budget, prefix, cutoff, dryRun, state, report } = ctx
  const folder = `${prefix}${buildId}/`
  const isRecent = (page: R2ObjectsLike) => page.objects.some((o) => o.uploaded.getTime() >= cutoff)

  let progress: BuildProgress =
    state.progress?.buildId === buildId && !(dryRun && state.progress.phase === 'delete')
      ? state.progress
      : { buildId, phase: 'scan', objects: 0 }
  state.progress = progress

  if (progress.phase === 'scan') {
    // A folder that fits in one page is already fully known after the first list call.
    let firstPage = progress.cursor === undefined && progress.objects === 0
    for (;;) {
      const page: R2ObjectsLike = await budget.call(() =>
        bucket.list({ prefix: folder, cursor: progress.cursor, limit: PAGE }),
      )
      if (isRecent(page)) {
        report.kept.push({ buildId, reason: 'recently-written' })
        state.progress = undefined
        return
      }
      if (firstPage && !page.truncated) {
        if (!dryRun && page.objects.length > 0) {
          const keys = page.objects.map((o) => o.key)
          await budget.call(() => bucket.delete(keys))
        }
        report.deleted.push({ buildId, objects: page.objects.length })
        state.progress = undefined
        return
      }
      firstPage = false
      progress = {
        buildId,
        phase: 'scan',
        cursor: page.truncated ? page.cursor : undefined,
        objects: progress.objects + page.objects.length,
      }
      state.progress = progress
      if (!page.truncated) break
    }
    if (dryRun) {
      report.deleted.push({ buildId, objects: progress.objects })
      state.progress = undefined
      return
    }
    progress = { buildId, phase: 'delete', objects: 0 }
    state.progress = progress
  }

  // Deleted keys disappear from the listing, so each round simply lists from the start again.
  for (;;) {
    const page: R2ObjectsLike = await budget.call(() =>
      bucket.list({ prefix: folder, limit: PAGE }),
    )
    if (page.objects.length === 0) break
    if (isRecent(page)) {
      report.kept.push({ buildId, reason: 'recently-written' })
      state.progress = undefined
      return
    }
    const keys = page.objects.map((o) => o.key)
    await budget.call(() => bucket.delete(keys))
    progress = { ...progress, objects: progress.objects + keys.length }
    state.progress = progress
    if (!page.truncated) break // that page held the rest of the folder
  }
  report.deleted.push({ buildId, objects: progress.objects })
  state.progress = undefined
}

function dropProgress(state: JanitorState, buildId: string): void {
  if (state.progress?.buildId === buildId) state.progress = undefined
}

async function listBuildIds(
  bucket: R2BucketLike,
  budget: Budget,
  prefix: string,
): Promise<{ buildIds: string[]; strayKey?: string }> {
  const buildIds: string[] = []
  let cursor: string | undefined
  do {
    const options: R2ListOptionsLike = { prefix, delimiter: '/', cursor, limit: PAGE }
    const page: R2ObjectsLike = await budget.call(() => bucket.list(options))
    if (page.objects.length > 0) return { buildIds, strayKey: page.objects[0]?.key }
    for (const p of page.delimitedPrefixes) buildIds.push(p.slice(prefix.length).replace(/\/$/, ''))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return { buildIds: buildIds.sort() }
}

/**
 * Starts after `resumeAfter` and wraps around, so successive runs make progress; a build with
 * saved progress goes first.
 */
function visitOrder(sortedIds: string[], state: JanitorState): string[] {
  const { resumeAfter, progress } = state
  let ids = sortedIds
  if (resumeAfter !== undefined) {
    const start = sortedIds.findIndex((id) => id > resumeAfter)
    if (start > 0) ids = [...sortedIds.slice(start), ...sortedIds.slice(0, start)]
  }
  return progress && ids.includes(progress.buildId)
    ? [progress.buildId, ...ids.filter((id) => id !== progress.buildId)]
    : ids
}
