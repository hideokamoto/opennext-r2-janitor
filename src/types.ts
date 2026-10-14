/**
 * The subset of the Workers `R2Bucket` binding this library uses.
 * Declared structurally so the package has no dependency on `@cloudflare/workers-types`
 * and can be exercised with an in-memory fake in tests.
 */
export interface R2BucketLike {
  list(options?: R2ListOptionsLike): Promise<R2ObjectsLike>
  delete(keys: string | string[]): Promise<void>
  get(key: string): Promise<{ text(): Promise<string> } | null>
  put(key: string, value: string): Promise<unknown>
}

export interface R2ListOptionsLike {
  prefix?: string
  delimiter?: string
  cursor?: string
  limit?: number
}

export interface R2ObjectsLike {
  objects: { key: string; uploaded: Date }[]
  delimitedPrefixes: string[]
  truncated: boolean
  cursor?: string
}

export interface CleanupOptions {
  /** The bucket bound as `NEXT_INC_CACHE_R2_BUCKET` in the OpenNext worker. */
  bucket: R2BucketLike
  /**
   * The build ID the production worker currently serves. Its cache is never deleted, and the run
   * aborts without deleting anything if no such build exists in the bucket.
   * Resolve it with `resolveBuildIdFromWorker()` inside the OpenNext worker, or with
   * `fetchBuildIdFromSite()` from a standalone worker.
   */
  currentBuildId: string
  /**
   * The cache key prefix. Must match `NEXT_INC_CACHE_R2_PREFIX` if the site sets it.
   * @default 'incremental-cache'
   */
  prefix?: string
  /**
   * A build is kept if it was written to, or seen as the current build, within this many days.
   * This covers rollbacks and preview versions, which share the bucket.
   * @default 14
   */
  keepDays?: number
  /**
   * When true, nothing is deleted; the report lists what would have been.
   * The state object is still written so that retention history builds up during a trial period.
   * @default true
   */
  dryRun?: boolean
  /**
   * Upper bound on R2 calls in one run. Each list, delete, get and put counts as one subrequest,
   * and Workers caps subrequests per invocation (50 on the Free plan). When the budget runs out the
   * run stops and the next run resumes where it left off.
   * @default 40
   */
  maxSubrequests?: number
  /**
   * Object key for the janitor's own state (which builds were current, and where to resume).
   * Must be outside `prefix`. Pass `null` to disable state; retention then relies on upload times only.
   * @default 'opennext-r2-janitor/state.json'
   */
  stateKey?: string | null
  /** Injected clock for tests. */
  now?: Date
}

export type KeepReason = 'current' | 'recently-current' | 'recently-written'

export type AbortReason = 'invalid-build-id' | 'current-build-not-found' | 'unexpected-layout'

export interface CleanupReport {
  dryRun: boolean
  currentBuildId: string
  prefix: string
  /** Build IDs found under the prefix during this run. */
  buildIds: number
  kept: { buildId: string; reason: KeepReason }[]
  /** Builds removed in this run, or that would have been in a dry run. */
  deleted: { buildId: string; objects: number }[]
  /** True when the subrequest budget ran out; the next run continues. */
  pending: boolean
  subrequests: number
  aborted?: { reason: AbortReason; detail: string }
}

export interface JanitorState {
  version: 1
  /** Build ID → ISO time it was last seen as the current build. */
  lastSeenCurrent: Record<string, string>
  /** Build ID to resume examining from when the previous run ran out of budget. */
  resumeAfter?: string
}
