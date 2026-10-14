import { isValidBuildId } from './buildId.js'
import type { BuildProgress, JanitorState, R2BucketLike } from './types.js'

/** Thrown when the state object exists but cannot be trusted. */
export class InvalidStateError extends Error {
  override name = 'InvalidStateError'
}

function emptyState(): JanitorState {
  return { version: 1, lastSeenCurrent: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProgress(value: unknown): BuildProgress {
  if (!isRecord(value) || !isValidBuildId(value.buildId)) {
    throw new InvalidStateError('progress.buildId is not a valid build ID')
  }
  if (value.phase !== 'scan' && value.phase !== 'delete') {
    throw new InvalidStateError('progress.phase must be "scan" or "delete"')
  }
  if (value.cursor !== undefined && typeof value.cursor !== 'string') {
    throw new InvalidStateError('progress.cursor must be a string')
  }
  if (typeof value.objects !== 'number' || !Number.isInteger(value.objects) || value.objects < 0) {
    throw new InvalidStateError('progress.objects must be a non-negative integer')
  }
  return {
    buildId: value.buildId,
    phase: value.phase,
    cursor: value.cursor,
    objects: value.objects,
  }
}

/**
 * Reads the state object.
 *
 * A missing object starts fresh. An object that cannot be read or does not have the expected shape
 * is an error rather than an empty state: the state records which builds were recently current,
 * and losing it could make the next run delete a build that should have been kept.
 */
export async function loadState(bucket: R2BucketLike, key: string): Promise<JanitorState> {
  const obj = await bucket.get(key)
  if (!obj) return emptyState()

  let parsed: unknown
  try {
    parsed = JSON.parse(await obj.text())
  } catch (e) {
    if (e instanceof SyntaxError) throw new InvalidStateError(`"${key}" is not valid JSON`)
    throw e
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.lastSeenCurrent)) {
    throw new InvalidStateError(`"${key}" is not a version 1 janitor state`)
  }

  const lastSeenCurrent: Record<string, string> = {}
  for (const [id, iso] of Object.entries(parsed.lastSeenCurrent)) {
    if (!isValidBuildId(id) || typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) {
      throw new InvalidStateError(`lastSeenCurrent has an invalid entry for "${id}"`)
    }
    lastSeenCurrent[id] = iso
  }
  if (parsed.resumeAfter !== undefined && !isValidBuildId(parsed.resumeAfter)) {
    throw new InvalidStateError('resumeAfter is not a valid build ID')
  }
  return {
    version: 1,
    lastSeenCurrent,
    resumeAfter: parsed.resumeAfter,
    progress: parsed.progress === undefined ? undefined : parseProgress(parsed.progress),
  }
}

export async function saveState(
  bucket: R2BucketLike,
  key: string,
  state: JanitorState,
): Promise<void> {
  await bucket.put(key, JSON.stringify(state))
}
