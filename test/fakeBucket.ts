import type { R2BucketLike, R2ListOptionsLike, R2ObjectsLike } from '../src/types.js'

/** In-memory stand-in for an R2 binding: lexicographic listing, delimiter folding and cursors. */
export class FakeBucket implements R2BucketLike {
  readonly objects = new Map<string, { uploaded: Date; body: string }>()
  calls = 0
  /** Page size the fake uses regardless of `limit`, to exercise pagination with small data. */
  constructor(private readonly pageSize = 1000) {}

  add(key: string, uploaded: Date | string, body = '{}'): this {
    this.objects.set(key, { uploaded: new Date(uploaded), body })
    return this
  }

  keys(): string[] {
    return [...this.objects.keys()].sort()
  }

  async list(options: R2ListOptionsLike = {}): Promise<R2ObjectsLike> {
    this.calls++
    const prefix = options.prefix ?? ''
    const limit = Math.min(options.limit ?? 1000, this.pageSize)
    // Entries are either keys or folded prefixes, in key order, like R2.
    const entries: { key: string; folded: boolean }[] = []
    const seen = new Set<string>()
    for (const key of this.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const idx = options.delimiter ? rest.indexOf(options.delimiter) : -1
      if (idx >= 0) {
        const folded = prefix + rest.slice(0, idx + 1)
        if (!seen.has(folded)) {
          seen.add(folded)
          entries.push({ key: folded, folded: true })
        }
      } else {
        entries.push({ key, folded: false })
      }
    }
    const start = options.cursor ? Number(options.cursor) : 0
    const page = entries.slice(start, start + limit)
    const truncated = start + limit < entries.length
    return {
      objects: page
        .filter((e) => !e.folded)
        .map((e) => ({ key: e.key, uploaded: this.objects.get(e.key)?.uploaded ?? new Date(0) })),
      delimitedPrefixes: page.filter((e) => e.folded).map((e) => e.key),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    this.calls++
    const list = Array.isArray(keys) ? keys : [keys]
    if (list.length > 1000) throw new Error('R2 delete accepts at most 1000 keys')
    for (const k of list) this.objects.delete(k)
  }

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    this.calls++
    const obj = this.objects.get(key)
    return obj ? { text: async () => obj.body } : null
  }

  async put(key: string, value: string): Promise<unknown> {
    this.calls++
    this.objects.set(key, { uploaded: new Date(), body: value })
    return {}
  }
}

/** Adds `count` cache entries for a build, all uploaded at `uploaded`. */
export function addBuild(
  bucket: FakeBucket,
  buildId: string,
  count: number,
  uploaded: string,
  prefix = 'incremental-cache',
): void {
  for (let i = 0; i < count; i++) {
    bucket.add(`${prefix}/${buildId}/${String(i).padStart(5, '0')}.cache`, uploaded)
  }
}
