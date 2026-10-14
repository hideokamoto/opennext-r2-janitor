import { describe, expect, it } from 'vitest'
import { cleanupOpenNextR2Cache, normalizePrefix } from '../src/cleanup.js'
import { addBuild, FakeBucket } from './fakeBucket.js'

const NOW = new Date('2026-10-14T00:00:00Z')
const STATE_KEY = 'opennext-r2-janitor/state.json'

function buildIdsLeft(bucket: FakeBucket): string[] {
  const ids = new Set<string>()
  for (const key of bucket.keys()) {
    const m = /^incremental-cache\/([^/]+)\//.exec(key)
    if (m?.[1]) ids.add(m[1])
  }
  return [...ids].sort()
}

describe('normalizePrefix', () => {
  it.each([
    ['incremental-cache', 'incremental-cache/'],
    ['/incremental-cache/', 'incremental-cache/'],
    ['a//b', 'a/b/'],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePrefix(input)).toBe(expected)
  })
})

describe('cleanupOpenNextR2Cache', () => {
  it('deletes stale builds and keeps the current one', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'old1', 3, '2026-08-01T00:00:00Z')
    addBuild(bucket, 'old2', 2, '2026-09-01T00:00:00Z')
    addBuild(bucket, 'cur', 4, '2026-09-29T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'cur',
      dryRun: false,
      now: NOW,
    })

    expect(report.aborted).toBeUndefined()
    expect(report.deleted).toEqual([
      { buildId: 'old1', objects: 3 },
      { buildId: 'old2', objects: 2 },
    ])
    expect(report.kept).toEqual([{ buildId: 'cur', reason: 'current' }])
    expect(buildIdsLeft(bucket)).toEqual(['cur'])
  })

  it('deletes nothing in a dry run (the default) but reports the plan', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'old', 3, '2026-08-01T00:00:00Z')
    addBuild(bucket, 'cur', 1, '2026-09-29T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({ bucket, currentBuildId: 'cur', now: NOW })

    expect(report.dryRun).toBe(true)
    expect(report.deleted).toEqual([{ buildId: 'old', objects: 3 }])
    expect(buildIdsLeft(bucket)).toEqual(['cur', 'old'])
  })

  it('keeps a build with any recent object, even on a later list page', async () => {
    const bucket = new FakeBucket(2)
    addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
    addBuild(bucket, 'prev', 5, '2026-08-01T00:00:00Z')
    // Lexicographically last, so it is only seen on the third page.
    bucket.add('incremental-cache/prev/zzzzz.cache', '2026-10-10T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'cur',
      dryRun: false,
      now: NOW,
    })

    expect(report.kept).toContainEqual({ buildId: 'prev', reason: 'recently-written' })
    expect(report.deleted).toEqual([])
    expect(buildIdsLeft(bucket)).toEqual(['cur', 'prev'])
  })

  it('keeps a build that was current recently even if it has not been written to', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'a', 2, '2026-01-01T00:00:00Z')
    addBuild(bucket, 'b', 2, '2026-10-13T00:00:00Z')
    bucket.add(
      STATE_KEY,
      '2026-10-12T00:00:00Z',
      JSON.stringify({ version: 1, lastSeenCurrent: { a: '2026-10-12T00:00:00Z' } }),
    )

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'b',
      dryRun: false,
      now: NOW,
    })

    expect(report.kept).toContainEqual({ buildId: 'a', reason: 'recently-current' })
    expect(buildIdsLeft(bucket)).toEqual(['a', 'b'])
  })

  it('records the current build in the state and drops builds that are gone', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'cur', 1, '2026-10-01T00:00:00Z')
    bucket.add(
      STATE_KEY,
      '2026-10-01T00:00:00Z',
      JSON.stringify({ version: 1, lastSeenCurrent: { gone: '2026-10-01T00:00:00Z' } }),
    )

    await cleanupOpenNextR2Cache({ bucket, currentBuildId: 'cur', now: NOW })

    const state = JSON.parse(bucket.objects.get(STATE_KEY)?.body ?? '{}')
    expect(state.lastSeenCurrent).toEqual({ cur: NOW.toISOString() })
  })

  it('aborts without deleting when the current build is not in the bucket', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'old', 3, '2026-08-01T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'missing',
      dryRun: false,
      now: NOW,
    })

    expect(report.aborted?.reason).toBe('current-build-not-found')
    expect(buildIdsLeft(bucket)).toEqual(['old'])
    expect(bucket.objects.has(STATE_KEY)).toBe(false)
  })

  it('aborts without deleting when objects sit directly under the prefix', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'old', 3, '2026-08-01T00:00:00Z')
    addBuild(bucket, 'cur', 1, '2026-10-01T00:00:00Z')
    bucket.add('incremental-cache/loose.cache', '2026-08-01T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'cur',
      dryRun: false,
      now: NOW,
    })

    expect(report.aborted?.reason).toBe('unexpected-layout')
    expect(buildIdsLeft(bucket)).toEqual(['cur', 'old'])
  })

  it.each(['', '../x', 'a/b', 'has space'])('rejects the build ID %j', async (id) => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'old', 1, '2026-08-01T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({ bucket, currentBuildId: id, dryRun: false })

    expect(report.aborted?.reason).toBe('invalid-build-id')
    expect(bucket.calls).toBe(0)
  })

  it('stops at the subrequest budget and resumes on the next run', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
    for (const id of ['o1', 'o2', 'o3', 'o4', 'o5']) addBuild(bucket, id, 1, '2026-08-01T00:00:00Z')

    // get state + list ids + (list + delete) per build = 2 + 2n, plus the reserved state write.
    const opts = { bucket, currentBuildId: 'cur', dryRun: false, now: NOW, maxSubrequests: 7 }
    const first = await cleanupOpenNextR2Cache(opts)
    expect(first.pending).toBe(true)
    expect(first.subrequests).toBeLessThanOrEqual(7)
    expect(first.deleted.map((d) => d.buildId)).toEqual(['o1', 'o2'])

    const second = await cleanupOpenNextR2Cache(opts)
    expect(second.deleted.map((d) => d.buildId)).toEqual(['o3', 'o4'])

    const third = await cleanupOpenNextR2Cache(opts)
    expect(third.pending).toBe(false)
    expect(buildIdsLeft(bucket)).toEqual(['cur'])
  })

  it('never exceeds the subrequest budget', async () => {
    const bucket = new FakeBucket(10)
    addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
    for (let i = 0; i < 20; i++) addBuild(bucket, `old${i}`, 25, '2026-08-01T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'cur',
      dryRun: false,
      now: NOW,
      maxSubrequests: 12,
    })

    expect(bucket.calls).toBeLessThanOrEqual(12)
    expect(report.subrequests).toBe(bucket.calls)
  })

  it('deletes in batches of at most 1000 keys', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
    addBuild(bucket, 'big', 2500, '2026-08-01T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'cur',
      dryRun: false,
      now: NOW,
    })

    expect(report.deleted).toEqual([{ buildId: 'big', objects: 2500 }])
    expect(buildIdsLeft(bucket)).toEqual(['cur'])
  })

  it('honours a custom prefix and leaves other keys alone', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z', 'site-a')
    addBuild(bucket, 'old', 2, '2026-08-01T00:00:00Z', 'site-a')
    bucket.add('unrelated/file.txt', '2020-01-01T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'cur',
      prefix: 'site-a',
      dryRun: false,
      now: NOW,
    })

    expect(report.deleted).toEqual([{ buildId: 'old', objects: 2 }])
    expect(bucket.objects.has('unrelated/file.txt')).toBe(true)
    expect(bucket.objects.has('site-a/cur/00000.cache')).toBe(true)
  })

  it('works without a state object', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
    addBuild(bucket, 'old', 1, '2026-08-01T00:00:00Z')

    const report = await cleanupOpenNextR2Cache({
      bucket,
      currentBuildId: 'cur',
      stateKey: null,
      dryRun: false,
      now: NOW,
    })

    expect(report.deleted.map((d) => d.buildId)).toEqual(['old'])
    expect(bucket.keys().some((k) => k.startsWith('opennext-r2-janitor/'))).toBe(false)
  })

  it('refuses a state key inside the cache prefix', async () => {
    await expect(
      cleanupOpenNextR2Cache({
        bucket: new FakeBucket(),
        currentBuildId: 'cur',
        stateKey: 'incremental-cache/state.json',
      }),
    ).rejects.toThrow(/must not be inside/)
  })

  it('treats a corrupt state object as empty', async () => {
    const bucket = new FakeBucket()
    addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
    bucket.add(STATE_KEY, '2026-10-01T00:00:00Z', 'not json')

    const report = await cleanupOpenNextR2Cache({ bucket, currentBuildId: 'cur', now: NOW })

    expect(report.aborted).toBeUndefined()
  })
})
