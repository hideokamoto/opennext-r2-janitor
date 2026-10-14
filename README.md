# opennext-r2-janitor

Delete the stale per-build incremental cache that [OpenNext for Cloudflare](https://opennext.js.org/cloudflare) leaves behind in R2.

## The problem

With the R2 incremental cache, OpenNext stores every entry at

```
<prefix>/<buildId>/<hash>.<cacheType>      # prefix defaults to "incremental-cache"
```

and `opennextjs-cloudflare deploy` uploads all prerendered pages under the new build ID. Nothing ever expires them: R2 has no per-object TTL and OpenNext does not delete the previous build's folder. Each deploy leaves one more folder that is never read again.

On one real site this added up to 143 build folders, about 79,000 objects and 10.8 GiB, of which only the current build (~0.3 GiB) was live. The same thing happens, more expensively, with the KV incremental cache.

## What this does

`cleanupOpenNextR2Cache()` lists the build folders under the prefix and deletes the ones that are no longer needed. Each build is judged on its own:

| Build | Decision |
|---|---|
| The current build ID | kept |
| Seen as the current build within `keepDays` (recorded in a small state object) | kept — covers rollbacks |
| Has any object uploaded within `keepDays` | kept — covers preview versions and recently replaced builds |
| Anything else | deleted |

Safety rails:

- **Dry run by default.** Nothing is deleted until you pass `dryRun: false`.
- **Aborts if the current build ID is not in the bucket.** That means a wrong prefix or a wrong build ID, so nothing is touched.
- **Aborts on an unexpected layout.** If any object sits directly under the prefix instead of in a `<buildId>/` folder, the run stops. This guards against a future OpenNext key format change.
- **Bounded per run.** At most `maxSubrequests` R2 calls per run (default 40, under the Workers Free plan limit of 50 subrequests). When the budget runs out, the next run resumes where this one stopped.

## Install

```sh
npm install opennext-r2-janitor
```

## Usage A: inside the OpenNext worker (recommended)

The site's own worker knows its build ID exactly. Wrap the generated worker as described in OpenNext's [Custom Worker](https://opennext.js.org/cloudflare/howtos/custom-worker) guide and add a `scheduled` handler:

```ts
// custom-worker.ts
// @ts-ignore: .open-next/worker.js is generated at build time
import { default as handler } from './.open-next/worker.js'
import { cleanupOpenNextR2Cache, resolveBuildIdFromWorker } from 'opennext-r2-janitor'

// Re-export the Durable Objects your open-next.config.ts uses, e.g. the DO queue:
// @ts-ignore
export { DOQueueHandler } from './.open-next/worker.js'

export default {
  fetch: handler.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const currentBuildId = await resolveBuildIdFromWorker({ assets: env.ASSETS })
        if (!currentBuildId) return console.warn('opennext-r2-janitor: build ID not found')
        const report = await cleanupOpenNextR2Cache({
          bucket: env.NEXT_INC_CACHE_R2_BUCKET,
          currentBuildId,
          dryRun: true, // flip to false after checking the logged report
        })
        console.log('opennext-r2-janitor', JSON.stringify(report))
      })(),
    )
  },
} satisfies ExportedHandler<CloudflareEnv>
```

```jsonc
// wrangler.jsonc
{
  "main": "./custom-worker.ts",
  "triggers": { "crons": ["17 3 * * *"] }
}
```

`resolveBuildIdFromWorker()` tries, in order:

1. `process.env.OPEN_NEXT_BUILD_ID`, the exact value OpenNext uses in cache keys (`deploymentId ?? BUILD_ID`);
2. the `BUILD_ID` file OpenNext emits into the static assets, read through the `ASSETS` binding.

## Usage B: one janitor worker for several sites

A standalone worker can clean the buckets of several OpenNext sites. Bind each bucket explicitly — the janitor only ever touches what you bind — and read each site's live build ID from `/BUILD_ID`, which OpenNext serves as a static asset:

```ts
import { cleanupOpenNextR2Cache, fetchBuildIdFromSite } from 'opennext-r2-janitor'

const SITES = [
  { url: 'https://example.com', bucket: 'EXAMPLE_CACHE' },
  { url: 'https://blog.example.com', bucket: 'BLOG_CACHE' },
] as const

export default {
  async scheduled(_event, env, ctx) {
    for (const site of SITES) {
      const currentBuildId = await fetchBuildIdFromSite(site.url)
      if (!currentBuildId) {
        console.warn('opennext-r2-janitor: no build ID for', site.url)
        continue
      }
      const report = await cleanupOpenNextR2Cache({
        bucket: env[site.bucket],
        currentBuildId,
        dryRun: true,
      })
      console.log('opennext-r2-janitor', site.url, JSON.stringify(report))
    }
  },
} satisfies ExportedHandler<Env>
```

```jsonc
{
  "name": "opennext-r2-janitor",
  "main": "./src/index.ts",
  "triggers": { "crons": ["17 3 * * *"] },
  "r2_buckets": [
    { "binding": "EXAMPLE_CACHE", "bucket_name": "example-opennext-cache" },
    { "binding": "BLOG_CACHE", "bucket_name": "blog-opennext-cache" }
  ]
}
```

All sites share one invocation's subrequest limit, and each `fetchBuildIdFromSite()` call counts towards it too, so split `maxSubrequests` between the sites (or raise it on the Paid plan, where the limit is 10,000).

> `/BUILD_ID` holds Next's build ID. If a site sets `deploymentId` in `next.config`, cache keys use that instead, the IDs will not match, and the run aborts with `current-build-not-found`. Use Usage A for such sites.

## Options

| Option | Default | Description |
|---|---|---|
| `bucket` | — | The R2 binding (`NEXT_INC_CACHE_R2_BUCKET` in the site's worker). |
| `currentBuildId` | — | The build ID the site currently serves. |
| `prefix` | `'incremental-cache'` | Must match `NEXT_INC_CACHE_R2_PREFIX` if the site sets it. |
| `keepDays` | `14` | Retention window for recently current and recently written builds. |
| `dryRun` | `true` | Report only; delete nothing. |
| `maxSubrequests` | `40` | Upper bound on R2 calls per run. |
| `stateKey` | `'opennext-r2-janitor/state.json'` | Where the janitor keeps its state; must be outside `prefix`. `null` disables it. |

## The report

```json
{
  "dryRun": false,
  "currentBuildId": "0KKOpE9zgeCUVjk8K5lyd",
  "prefix": "incremental-cache/",
  "buildIds": 3,
  "kept": [{ "buildId": "0KKOpE9zgeCUVjk8K5lyd", "reason": "current" }],
  "deleted": [{ "buildId": "OLDA", "objects": 2 }, { "buildId": "OLDB", "objects": 1 }],
  "pending": false,
  "subrequests": 7
}
```

`aborted` is present, with a `reason` of `invalid-build-id`, `current-build-not-found` or `unexpected-layout`, when the run refused to delete anything. `pending: true` means the budget ran out and the next run continues.

## Rolling it out

1. Deploy with `dryRun: true` and let it run for a few days. The state object starts recording which build is current, which later protects rollback targets.
2. Read the logged report. Every `deleted` entry should be a build you no longer need.
3. Switch to `dryRun: false`. A large backlog is cleared over several runs.

## Limitations

- **Depends on OpenNext's key layout.** The `<prefix>/<buildId>/…` structure is an implementation detail of `@opennextjs/cloudflare` (`computeCacheKey`, verified against 1.19.11), not a public API. The layout check makes the janitor stop rather than guess if it changes.
- **Large build folders.** A build is only deleted after all of its objects have been listed (any recent object keeps it). Listing and deleting share the budget, so with the default of 40 a folder of up to roughly 35,000 objects is removed over several runs; raise `maxSubrequests` for larger ones.
- **Free plan CPU.** Cron invocations on Workers Free get 10 ms of CPU time. This has not been measured for large buckets; if runs are cut off, lower `maxSubrequests`.
- **Builds from before the janitor was installed** have no state entry, so they are kept only if they were written to within `keepDays`. Check the first dry-run report for builds you may still want to roll back to.

## License

MIT
