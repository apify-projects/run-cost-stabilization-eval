## What does Run cost stabilization evaluator do?

The cost of an Apify Actor run is not final when the run finishes. Distributed services keep reporting usage and charged events for a while after the run reaches a terminal status, and there is no consistency mechanism that says "the cost is now final".

This Actor measures **how long you need to wait after a run finishes until its cost stops changing in the API**. It runs each Actor you give it many times with its prefilled input, watches the cost of every finished run, and reports per-Actor statistics (min, median, max, and percentiles up to p99.9).

## How it works

For each Actor in the input:

1. Loads the Actor's default build (or the build you pick) and builds the run input from the `prefill` values in its input schema, the same input you get in Console when you click Start without changing anything. If the schema has no prefills, the Actor's example run input is used. You can merge extra fields over it with `inputOverrides`.
2. Starts the run and waits for it to finish. The run object returned when the run finishes is the first cost snapshot.
3. Polls `GET /v2/actor-runs/:runId` every 100 ms. After the cost has been unchanged for 2 s, polling slows down to every 500 ms. Any change switches it back to 100 ms.
4. Once no tracked field changed for 10 s, the run counts as stabilized. A run that is still changing after 10 minutes counts as not stabilized.
5. Records, separately for each tracked field, the time from the run's `finishedAt` to the first poll that returned its final value.

Runs of all Actors are interleaved and executed with a configurable concurrency (5 by default). Each iteration is a separate run.

### Tracked signals

Each field is tracked and reported separately, so you can see which part of the cost settles last. That matters because pay-per-event and pay-per-usage Actors are billed differently.

| Signal               | What changes                                                                         |
| -------------------- | ------------------------------------------------------------------------------------ |
| `usageTotalUsd`      | Platform usage cost in USD. **This is the headline number, used for all Actors.**    |
| `usage`              | The raw `usage` object (compute units, storage operations, data transfer, and so on) |
| `chargedEventCounts` | The `chargedEventCounts` object of pay-per-event Actors                              |

Stats for a signal only include runs that reported that field, so pay-per-usage Actors have no `chargedEventCounts` stats (`count: 0`) instead of misleading zeros. The 10 s stable window restarts when any of the signals changes, so a late event count change is still measured even if `usageTotalUsd` is already final.

## Input

| Field                                                                | Default   | Description                                                   |
| -------------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| `actors`                                                             | –         | Actor IDs or names, e.g. `apify/website-content-crawler`      |
| `iterations`                                                         | 50        | Runs per Actor                                                |
| `maxConcurrentRuns`                                                  | 5         | Evaluated runs in flight at once, across all Actors           |
| `inputOverrides`                                                     | `{}`      | Per-Actor input merged over the prefill, keyed as in `actors` |
| `fastPollIntervalMillis` / `slowPollIntervalMillis`                  | 100 / 500 | Poll intervals                                                |
| `slowdownAfterMillis`                                                | 2000      | Unchanged time before switching to the slow interval          |
| `stableWindowMillis`                                                 | 10000     | Unchanged time before a run counts as stabilized              |
| `maxTrackingMillis`                                                  | 600000    | Give up on a run this long after it finished                  |
| `runMemoryMbytes`, `runTimeoutSecs`, `runBuild`, `maxTotalChargeUsd` | –         | Options for the evaluated runs                                |

```json
{
    "actors": ["apify/website-content-crawler", "apify/google-search-scraper"],
    "iterations": 50,
    "inputOverrides": { "apify/website-content-crawler": { "maxCrawlPages": 1 } }
}
```

## Output

### Dataset: one item per Actor

```json
{
    "actor": "apify/google-search-scraper",
    "pricingModel": "PAY_PER_EVENT",
    "inputSource": "inputSchemaPrefill",
    "runsTotal": 50,
    "runsStabilized": 50,
    "runsReportingSignal": { "usageTotalUsd": 50, "usage": 50, "chargedEventCounts": 50 },
    "runsWithChangeAfterFinish": { "usageTotalUsd": 37, "usage": 41, "chargedEventCounts": 12 },
    "usageTotalUsdStabilizationMs": {
        "count": 50,
        "min": 180,
        "max": 4210,
        "mean": 1103.5,
        "median": 950,
        "p75": 1420,
        "p90": 2210,
        "p95": 2890,
        "p99": 3950,
        "p99_9": 4184
    },
    "usageTotalUsdStabilizationLowerBoundMs": { "...": "same shape" },
    "usageTotalUsdChangeCount": { "...": "same shape" },
    "usageStabilizationMs": { "...": "same shape" },
    "usageStabilizationLowerBoundMs": { "...": "same shape" },
    "usageChangeCount": { "...": "same shape" },
    "chargedEventCountsStabilizationMs": { "...": "same shape" },
    "chargedEventCountsStabilizationLowerBoundMs": { "...": "same shape" },
    "chargedEventCountsChangeCount": { "...": "same shape" },
    "firstSnapshotLagMs": { "...": "same shape" },
    "usageTotalUsdIncreaseAfterFinish": { "...": "same shape" },
    "finalUsageTotalUsd": { "...": "same shape" },
    "finalEventChargeUsd": { "...": "same shape" },
    "detailsKey": "RUNS-apify-google-search-scraper",
    "detailsUrl": "https://api.apify.com/v2/key-value-stores/.../records/RUNS-apify-google-search-scraper"
}
```

(The numbers above are illustrative.)

- `*StabilizationMs` is computed over stabilized runs only. It is the time from `finishedAt` until the final value was first seen, so it is an upper bound with poll-interval precision. `*StabilizationLowerBoundMs` gives the matching lower bound: the last poll that still returned the old value. It only covers runs where a change was seen.
- If a field never changed after we first looked, the stabilization time equals `firstSnapshotLagMs`, the delay between `finishedAt` and the moment the finished run was returned to us.
- For pay-per-event Actors, `finalEventChargeUsd` is computed from `chargedEventCounts` and the event prices in the run's pricing info.

### Key-value store: per-run details

Each Actor gets a `RUNS-<actor>` record with the input used, the options, and for every run: run ID, status, timestamps, the initial and final cost snapshots, per-signal results, and the full list of observed changes (`observedAfterMs` and the snapshot at that moment). The record is updated after every run, so partial results are available while the evaluation is still going.

## Notes and limitations

- Times are measured with the evaluator's clock against the API's `finishedAt`. Both run on Apify infrastructure with synced clocks, but small clock offsets directly shift the numbers.
- Polling many runs at 100 ms adds up to a lot of API requests. With the default concurrency of 5, that is up to 50 requests per second. Raise `maxConcurrentRuns` with care.
- If starting or finishing a run of an Actor fails 3 times in a row, the remaining runs of that Actor are skipped and the summary includes the errors.
- Progress is persisted, so after a migration the evaluation continues with the runs that are left. Runs that were being tracked at the moment of migration are lost and are re-run.
- The evaluated runs cost money. Use `inputOverrides`, `runMemoryMbytes`, and `maxTotalChargeUsd` to keep them small.

## Development

```bash
npm install
npm test        # unit tests (stats, stabilization tracker)
npm run lint
npm run build
apify run       # needs `apify login`; evaluated runs are billed to your account
```
