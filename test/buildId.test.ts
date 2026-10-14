import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBuildIdFromSite, isValidBuildId, resolveBuildIdFromWorker } from '../src/buildId.js'

function assets(status: number, body: string) {
  return { fetch: vi.fn(async () => new Response(body, { status })) }
}

describe('isValidBuildId', () => {
  it.each(['0l2Y2uQ779vMVWa1jXBPN', '-td3RDw7cbHrKG4t51SnK', 'dpl_123.abc'])('accepts %s', (id) => {
    expect(isValidBuildId(id)).toBe(true)
  })
  it.each(['', '.', '..', 'a/b', 'a b', 'x'.repeat(129), undefined, 1])('rejects %j', (id) => {
    expect(isValidBuildId(id)).toBe(false)
  })
})

describe('resolveBuildIdFromWorker', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers process.env.OPEN_NEXT_BUILD_ID', async () => {
    vi.stubEnv('OPEN_NEXT_BUILD_ID', 'fromEnv')
    const a = assets(200, 'fromAssets')
    expect(await resolveBuildIdFromWorker({ assets: a })).toBe('fromEnv')
    expect(a.fetch).not.toHaveBeenCalled()
  })

  it('falls back to the BUILD_ID asset', async () => {
    vi.stubEnv('OPEN_NEXT_BUILD_ID', '')
    expect(await resolveBuildIdFromWorker({ assets: assets(200, 'fromAssets\n') })).toBe(
      'fromAssets',
    )
  })

  it('returns null when nothing usable is found', async () => {
    vi.stubEnv('OPEN_NEXT_BUILD_ID', '')
    expect(await resolveBuildIdFromWorker({ assets: assets(404, 'nope') })).toBeNull()
    expect(await resolveBuildIdFromWorker({ assets: assets(200, '<html>') })).toBeNull()
    expect(await resolveBuildIdFromWorker()).toBeNull()
  })
})

describe('fetchBuildIdFromSite', () => {
  it('reads /BUILD_ID from the site origin', async () => {
    const fetchImpl = vi.fn(async () => new Response('abc123\n'))
    expect(await fetchBuildIdFromSite('https://example.com/some/page', fetchImpl)).toBe('abc123')
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/BUILD_ID', { redirect: 'follow' })
  })

  it('returns null for an error status or an HTML body', async () => {
    expect(
      await fetchBuildIdFromSite(
        'https://example.com',
        async () => new Response('', { status: 404 }),
      ),
    ).toBeNull()
    expect(
      await fetchBuildIdFromSite(
        'https://example.com',
        async () => new Response('<!doctype html>'),
      ),
    ).toBeNull()
  })
})
