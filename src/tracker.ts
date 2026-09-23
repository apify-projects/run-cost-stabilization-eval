import { setTimeout as defaultSleep } from 'node:timers/promises';

import type { ActorRun } from 'apify-client';

/**
 * Cost-related fields of a run that we watch for changes. Each signal is tracked separately so
 * we can tell e.g. pay-per-event charges apart from platform usage. `usageTotalUsd` is the headline one.
 */
export const SIGNALS = ['usageTotalUsd', 'usage', 'chargedEventCounts'] as const;
export type Signal = (typeof SIGNALS)[number];

export interface CostSnapshot {
    usageTotalUsd: number | null;
    /** Pay-per-event charges computed from `chargedEventCounts` and the run's pricing info. */
    eventChargeUsd: number | null;
    chargedEventCounts: Record<string, number> | null;
    usage: Record<string, number> | null;
}

export interface TrackerOptions {
    fastPollIntervalMillis: number;
    slowPollIntervalMillis: number;
    slowdownAfterMillis: number;
    stableWindowMillis: number;
    maxTrackingMillis: number;
    /** Give up after this many consecutive failed polls. */
    maxConsecutivePollErrors?: number;
}

export interface SignalResult {
    /** Whether the run reported this field at all (e.g. `chargedEventCounts` only exists for pay-per-event). */
    present: boolean;
    /** Number of changes observed after the run finished (after the first snapshot). */
    changeCount: number;
    /**
     * Time from `finishedAt` until the final value was first observed. When no change was observed,
     * this is the lag of the first snapshot (i.e. the value was already final when we first looked).
     */
    stabilizedAfterMs: number;
    /**
     * Time from `finishedAt` of the last poll that still returned the previous value.
     * The true stabilization moment lies between this and `stabilizedAfterMs`.
     * `null` when no change was observed.
     */
    stabilizedAfterLowerBoundMs: number | null;
}

export interface CostChange {
    /** Milliseconds since the run's `finishedAt`. */
    observedAfterMs: number;
    changedSignals: Signal[];
    snapshot: CostSnapshot;
}

export interface TrackingResult {
    stabilized: boolean;
    /** Lag between `finishedAt` and the first snapshot we got (the one returned by waiting for finish). */
    firstSnapshotLagMs: number;
    trackedForMs: number;
    pollCount: number;
    pollErrorCount: number;
    initialSnapshot: CostSnapshot;
    finalSnapshot: CostSnapshot;
    signals: Record<Signal, SignalResult>;
    changes: CostChange[];
}

export interface TrackerDeps {
    fetchRun: () => Promise<ActorRun | undefined>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

/** JSON with sorted keys so that key order changes are not reported as value changes. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function snapshotFromRun(run: ActorRun): CostSnapshot {
    const chargedEventCounts = run.chargedEventCounts ?? null;
    let eventChargeUsd: number | null = null;
    if (run.pricingInfo?.pricingModel === 'PAY_PER_EVENT' && chargedEventCounts) {
        const events = run.pricingInfo.pricingPerEvent?.actorChargeEvents ?? {};
        eventChargeUsd = Object.entries(chargedEventCounts).reduce(
            (sum, [name, count]) => sum + (events[name]?.eventPriceUsd ?? 0) * count,
            0,
        );
    }
    return {
        usageTotalUsd: run.usageTotalUsd ?? null,
        eventChargeUsd,
        chargedEventCounts,
        usage: (run.usage as Record<string, number> | undefined) ?? null,
    };
}

function fingerprint(snapshot: CostSnapshot, signal: Signal): string {
    return stableStringify(snapshot[signal]);
}

/**
 * Polls a finished run until its cost stops changing.
 *
 * Polls every `fastPollIntervalMillis`; once nothing changed for `slowdownAfterMillis` it switches to
 * `slowPollIntervalMillis`, and any change switches back to fast polling. The run is considered
 * stabilized once no signal changed for `stableWindowMillis`.
 */
export async function trackCostStabilization(
    finishedRun: ActorRun,
    firstSnapshotObservedAt: number,
    options: TrackerOptions,
    deps: TrackerDeps,
): Promise<TrackingResult> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? (async (ms: number) => defaultSleep(ms));
    const maxConsecutivePollErrors = options.maxConsecutivePollErrors ?? 50;
    const finishedAt = new Date(finishedRun.finishedAt).getTime();

    const initialSnapshot = snapshotFromRun(finishedRun);
    let lastSnapshot = initialSnapshot;
    const fingerprints = Object.fromEntries(SIGNALS.map((s) => [s, fingerprint(initialSnapshot, s)])) as Record<
        Signal,
        string
    >;
    const signals = Object.fromEntries(
        SIGNALS.map((s) => [
            s,
            {
                present: initialSnapshot[s] !== null,
                changeCount: 0,
                stabilizedAfterMs: firstSnapshotObservedAt - finishedAt,
                stabilizedAfterLowerBoundMs: null,
            },
        ]),
    ) as Record<Signal, SignalResult>;

    const changes: CostChange[] = [];
    let lastChangeObservedAt = firstSnapshotObservedAt;
    let previousObservedAt = firstSnapshotObservedAt;
    let lastPollStartedAt = firstSnapshotObservedAt;
    let pollCount = 0;
    let pollErrorCount = 0;
    let consecutivePollErrors = 0;
    let stabilized = false;

    for (;;) {
        const sinceLastChange = now() - lastChangeObservedAt;
        if (sinceLastChange >= options.stableWindowMillis) {
            stabilized = true;
            break;
        }
        if (now() - finishedAt >= options.maxTrackingMillis) break;

        const interval =
            sinceLastChange >= options.slowdownAfterMillis
                ? options.slowPollIntervalMillis
                : options.fastPollIntervalMillis;
        const waitMs = lastPollStartedAt + interval - now();
        if (waitMs > 0) await sleep(waitMs);

        lastPollStartedAt = now();
        let run: ActorRun | undefined;
        try {
            run = await deps.fetchRun();
            if (!run) throw new Error(`Run ${finishedRun.id} not found`);
            consecutivePollErrors = 0;
        } catch (err) {
            pollErrorCount++;
            consecutivePollErrors++;
            if (consecutivePollErrors >= maxConsecutivePollErrors) throw err;
            continue;
        }
        pollCount++;
        const observedAt = now();
        const snapshot = snapshotFromRun(run);

        const changedSignals: Signal[] = [];
        for (const signal of SIGNALS) {
            const fp = fingerprint(snapshot, signal);
            if (fp === fingerprints[signal]) continue;
            fingerprints[signal] = fp;
            changedSignals.push(signal);
            const result = signals[signal];
            if (snapshot[signal] !== null) result.present = true;
            result.changeCount++;
            result.stabilizedAfterMs = observedAt - finishedAt;
            result.stabilizedAfterLowerBoundMs = previousObservedAt - finishedAt;
        }
        if (changedSignals.length > 0) {
            lastChangeObservedAt = observedAt;
            changes.push({ observedAfterMs: observedAt - finishedAt, changedSignals, snapshot });
        }
        lastSnapshot = snapshot;
        previousObservedAt = observedAt;
    }

    return {
        stabilized,
        firstSnapshotLagMs: firstSnapshotObservedAt - finishedAt,
        trackedForMs: now() - firstSnapshotObservedAt,
        pollCount,
        pollErrorCount,
        initialSnapshot,
        finalSnapshot: lastSnapshot,
        signals,
        changes,
    };
}
