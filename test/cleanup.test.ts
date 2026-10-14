import { describe, expect, it } from 'vitest'
import { cleanupOpenNextR2Cache, normalizePrefix } from '../src/cleanup.js'
import type { CleanupReport } from '../src/types.js'
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

  describe('maxSubrequests', () => {
    it.each([
      [4, undefined],
      [2, null],
    ] as const)('rejects %i when stateKey is %j: a delete round would never fit', async (n, stateKey) => {
      await expect(
        cleanupOpenNextR2Cache({
          bucket: new FakeBucket(),
          currentBuildId: 'cur',
          maxSubrequests: n,
          ...(stateKey === null ? { stateKey } : {}),
        }),
      ).rejects.toThrow(/maxSubrequests must be at least/)
    })

    it('the minimum with a state object (5) clears a multi-page build over several runs', async () => {
      const bucket = new FakeBucket(5)
      addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
      addBuild(bucket, 'big', 23, '2026-08-01T00:00:00Z')
      let report = {} as CleanupReport
      for (let i = 0; i < 40 && (i === 0 || report.pending); i++) {
        report = await cleanupOpenNextR2Cache({
          bucket,
          currentBuildId: 'cur',
          dryRun: false,
          now: NOW,
          maxSubrequests: 5,
        })
      }
      expect(report.pending).toBe(false)
      expect(buildIdsLeft(bucket)).toEqual(['cur'])
    })

    it('the minimum without a state object (3) clears a build that fits in one run', async () => {
      const bucket = new FakeBucket()
      addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
      addBuild(bucket, 'old', 3, '2026-08-01T00:00:00Z')
      const report = await cleanupOpenNextR2Cache({
        bucket,
        currentBuildId: 'cur',
        dryRun: false,
        now: NOW,
        maxSubrequests: 3,
        stateKey: null,
      })
      expect(report.deleted).toEqual([{ buildId: 'old', objects: 3 }])
      expect(buildIdsLeft(bucket)).toEqual(['cur'])
    })

    it('without a state object, a build that does not fit in one run is never finished', async () => {
      const bucket = new FakeBucket(5)
      addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
      addBuild(bucket, 'big', 23, '2026-08-01T00:00:00Z')
      for (let i = 0; i < 5; i++) {
        const report = await cleanupOpenNextR2Cache({
          bucket,
          currentBuildId: 'cur',
          dryRun: false,
          now: NOW,
          maxSubrequests: 3,
          stateKey: null,
        })
        expect(report.pending).toBe(true)
      }
      expect(buildIdsLeft(bucket)).toEqual(['big', 'cur']) // nothing half-deleted either
    })
  })

  describe('unreadable state', () => {
    it.each([
      ['not json', 'not json'],
      ['wrong version', JSON.stringify({ version: 2, lastSeenCurrent: {} })],
      ['array', '[]'],
      ['bad entry', JSON.stringify({ version: 1, lastSeenCurrent: { 'a/b': 'x' } })],
      ['bad date', JSON.stringify({ version: 1, lastSeenCurrent: { a: 'yesterday' } })],
      [
        'bad progress',
        JSON.stringify({ version: 1, lastSeenCurrent: {}, progress: { buildId: 'a' } }),
      ],
    ])('aborts without deleting when the state is %s', async (_name, body) => {
      const bucket = new FakeBucket()
      addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
      addBuild(bucket, 'old', 2, '2026-08-01T00:00:00Z')
      bucket.add(STATE_KEY, '2026-10-01T00:00:00Z', body)

      const report = await cleanupOpenNextR2Cache({
        bucket,
        currentBuildId: 'cur',
        dryRun: false,
        now: NOW,
      })

      expect(report.aborted?.reason).toBe('unreadable-state')
      expect(buildIdsLeft(bucket)).toEqual(['cur', 'old'])
      expect(bucket.objects.get(STATE_KEY)?.body).toBe(body) // left for a human to look at
    })

    it('still starts fresh when the state object does not exist', async () => {
      const bucket = new FakeBucket()
      addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
      const report = await cleanupOpenNextR2Cache({ bucket, currentBuildId: 'cur', now: NOW })
      expect(report.aborted).toBeUndefined()
    })
  })

  describe('a build folder larger than one run can list', () => {
    // pageSize 5 and maxSubrequests 5 (4 usable): each run lists/deletes at most a couple of pages.
    const setup = () => {
      const bucket = new FakeBucket(5)
      addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
      addBuild(bucket, 'big', 23, '2026-08-01T00:00:00Z')
      addBuild(bucket, 'zzz', 3, '2026-08-01T00:00:00Z') // sorts after big
      return bucket
    }
    const opts = (bucket: FakeBucket, dryRun: boolean) => ({
      bucket,
      currentBuildId: 'cur',
      dryRun,
      now: NOW,
      maxSubrequests: 5,
    })

    it('deletes it over several runs, then goes on to the builds after it', async () => {
      const bucket = setup()
      const deleted: Record<string, number> = {}
      let runs = 0
      for (let report = { pending: true } as CleanupReport; report.pending; runs++) {
        expect(runs).toBeLessThan(30)
        report = await cleanupOpenNextR2Cache(opts(bucket, false))
        expect(report.subrequests).toBeLessThanOrEqual(5)
        for (const d of report.deleted) deleted[d.buildId] = d.objects
      }
      expect(runs).toBeGreaterThan(3) // it really did need multiple runs
      expect(deleted).toEqual({ big: 23, zzz: 3 })
      expect(buildIdsLeft(bucket)).toEqual(['cur'])
      expect(JSON.parse(bucket.objects.get(STATE_KEY)?.body ?? '{}').progress).toBeUndefined()
    })

    it('reports the same plan in a dry run without deleting anything', async () => {
      const bucket = setup()
      const planned: Record<string, number> = {}
      for (let i = 0, report = { pending: true } as CleanupReport; report.pending; i++) {
        expect(i).toBeLessThan(30)
        report = await cleanupOpenNextR2Cache(opts(bucket, true))
        for (const d of report.deleted) planned[d.buildId] = d.objects
      }
      expect(planned).toEqual({ big: 23, zzz: 3 })
      expect(buildIdsLeft(bucket)).toEqual(['big', 'cur', 'zzz'])
    })

    it('reports where an unfinished build stands', async () => {
      const bucket = setup()
      const report = await cleanupOpenNextR2Cache(opts(bucket, false))
      expect(report.pending).toBe(true)
      expect(report.partial).toMatchObject({ buildId: 'big', phase: 'scan' })
    })

    it('keeps the whole build when a recent object shows up late in the scan', async () => {
      const bucket = setup()
      await cleanupOpenNextR2Cache(opts(bucket, false)) // scans the first pages only
      bucket.add('incremental-cache/big/zzzzz.cache', '2026-10-13T12:00:00Z')

      let last = {} as CleanupReport
      for (let i = 0; i < 30 && (i === 0 || last.pending); i++) {
        last = await cleanupOpenNextR2Cache(opts(bucket, false))
      }

      expect(buildIdsLeft(bucket)).toEqual(['big', 'cur'])
      expect(bucket.keys().filter((k) => k.startsWith('incremental-cache/big/'))).toHaveLength(24)
    })

    it('stops deleting when an object is written after the scan finished', async () => {
      const bucket = setup()
      // Drive the build to the delete phase, then stop before it is emptied.
      for (let i = 0; i < 30; i++) {
        await cleanupOpenNextR2Cache(opts(bucket, false))
        const state = JSON.parse(bucket.objects.get(STATE_KEY)?.body ?? '{}')
        if (state.progress?.phase === 'delete') break
      }
      bucket.add('incremental-cache/big/00000.cache', '2026-10-13T12:00:00Z') // overwritten, now recent

      for (let i = 0, r = { pending: true } as CleanupReport; r.pending && i < 30; i++) {
        r = await cleanupOpenNextR2Cache(opts(bucket, false))
      }

      expect(bucket.objects.has('incremental-cache/big/00000.cache')).toBe(true)
      expect(JSON.parse(bucket.objects.get(STATE_KEY)?.body ?? '{}').progress).toBeUndefined()
    })

    it('discards a saved cursor the backend rejects, then recovers on the next run', async () => {
      const bucket = setup()
      bucket.add(
        STATE_KEY,
        '2026-10-01T00:00:00Z',
        JSON.stringify({
          version: 1,
          lastSeenCurrent: {},
          progress: { buildId: 'big', phase: 'scan', cursor: 'garbage', objects: 5 },
        }),
      )

      await expect(cleanupOpenNextR2Cache(opts(bucket, false))).rejects.toThrow(/invalid cursor/)
      expect(JSON.parse(bucket.objects.get(STATE_KEY)?.body ?? '{}').progress).toBeUndefined()

      for (let i = 0, r = { pending: true } as CleanupReport; r.pending && i < 30; i++) {
        r = await cleanupOpenNextR2Cache(opts(bucket, false))
      }
      expect(buildIdsLeft(bucket)).toEqual(['cur'])
    })

    it('forgets progress for a build that has disappeared', async () => {
      const bucket = new FakeBucket()
      addBuild(bucket, 'cur', 1, '2026-10-13T00:00:00Z')
      bucket.add(
        STATE_KEY,
        '2026-10-01T00:00:00Z',
        JSON.stringify({
          version: 1,
          lastSeenCurrent: {},
          progress: { buildId: 'gone', phase: 'delete', objects: 40 },
        }),
      )

      const report = await cleanupOpenNextR2Cache({ bucket, currentBuildId: 'cur', now: NOW })

      expect(report.aborted).toBeUndefined()
      expect(JSON.parse(bucket.objects.get(STATE_KEY)?.body ?? '{}').progress).toBeUndefined()
    })
  })
})
