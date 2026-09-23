import type { ActorRun } from 'apify-client';
import { describe, expect, it } from 'vitest';

import { trackCostStabilization, type TrackerOptions } from '../src/tracker.js';

const options: TrackerOptions = {
    fastPollIntervalMillis: 100,
    slowPollIntervalMillis: 500,
    slowdownAfterMillis: 2000,
    stableWindowMillis: 10_000,
    maxTrackingMillis: 60_000,
};

const FINISHED_AT = 1_000_000;

function makeRun(usageTotalUsd: number, chargedEventCounts?: Record<string, number>): ActorRun {
    return {
        id: 'run1',
        finishedAt: new Date(FINISHED_AT),
        usageTotalUsd,
        chargedEventCounts,
        pricingInfo: chargedEventCounts
            ? {
                  pricingModel: 'PAY_PER_EVENT',
                  pricingPerEvent: { actorChargeEvents: { result: { eventPriceUsd: 0.01, eventTitle: 'Result' } } },
              }
            : undefined,
    } as unknown as ActorRun;
}

/** Fake clock where each API call takes 20 ms and the cost follows `costAt(msSinceFinish)`. */
function setup(costAt: (sinceFinish: number) => ActorRun) {
    let t = FINISHED_AT + 300;
    let calls = 0;
    return {
        firstObservedAt: t,
        deps: {
            now: () => t,
            sleep: async (ms: number) => {
                t += ms;
            },
            fetchRun: async () => {
                calls++;
                t += 20;
                return costAt(t - FINISHED_AT);
            },
        },
        calls: () => calls,
    };
}

describe('trackCostStabilization', () => {
    it('reports first snapshot lag when cost never changes', async () => {
        const { deps, firstObservedAt } = setup(() => makeRun(0.5));
        const result = await trackCostStabilization(makeRun(0.5), firstObservedAt, options, deps);
        expect(result.stabilized).toBe(true);
        expect(result.signals.usageTotalUsd.changeCount).toBe(0);
        expect(result.signals.usageTotalUsd.stabilizedAfterMs).toBe(300);
        expect(result.signals.usageTotalUsd.stabilizedAfterLowerBoundMs).toBeNull();
        expect(result.changes).toEqual([]);
        expect(result.signals.usageTotalUsd.present).toBe(true);
        expect(result.signals.chargedEventCounts.present).toBe(false);
    });

    it('detects the last change and waits the full stable window after it', async () => {
        const costAt = (ms: number) => makeRun(ms < 1500 ? 0.5 : ms < 4000 ? 0.6 : 0.65);
        const { deps, firstObservedAt, calls } = setup(costAt);
        const result = await trackCostStabilization(makeRun(0.5), firstObservedAt, options, deps);

        expect(result.stabilized).toBe(true);
        expect(result.signals.usageTotalUsd.changeCount).toBe(2);
        expect(result.signals.chargedEventCounts.changeCount).toBe(0);
        // Second change happens at 4000 ms; after 2 s of silence polling slows to 500 ms, so it is seen within 500 ms.
        expect(result.signals.usageTotalUsd.stabilizedAfterMs).toBeGreaterThanOrEqual(4000);
        expect(result.signals.usageTotalUsd.stabilizedAfterMs).toBeLessThan(4600);
        expect(result.signals.usageTotalUsd.stabilizedAfterLowerBoundMs).toBeLessThan(4000);
        expect(result.finalSnapshot.usageTotalUsd).toBe(0.65);
        expect(result.trackedForMs).toBeGreaterThanOrEqual(
            result.signals.usageTotalUsd.stabilizedAfterMs - 300 + 10_000,
        );
        // Fast polling right after finish, slow polling later: far fewer polls than 14 s / 100 ms.
        expect(calls()).toBeLessThan(80);
    });

    it('tracks pay-per-event charges separately', async () => {
        const costAt = (ms: number) => makeRun(0.1, { result: ms < 700 ? 5 : 8 });
        const { deps, firstObservedAt } = setup(costAt);
        const result = await trackCostStabilization(makeRun(0.1, { result: 5 }), firstObservedAt, options, deps);
        expect(result.signals.chargedEventCounts.changeCount).toBe(1);
        expect(result.signals.usageTotalUsd.changeCount).toBe(0);
        expect(result.signals.chargedEventCounts.present).toBe(true);
        expect(result.signals.chargedEventCounts.stabilizedAfterMs).toBeGreaterThanOrEqual(700);
        expect(result.signals.chargedEventCounts.stabilizedAfterMs).toBeLessThan(840);
        // usageTotalUsd never changed, so it was final already at the first snapshot.
        expect(result.signals.usageTotalUsd.stabilizedAfterMs).toBe(300);
        // The stable window waits for all signals, so tracking continues 10 s after the event count change.
        expect(result.trackedForMs).toBeGreaterThanOrEqual(10_000 + 700 - 300);
        expect(result.initialSnapshot.eventChargeUsd).toBeCloseTo(0.05);
        expect(result.finalSnapshot.eventChargeUsd).toBeCloseTo(0.08);
    });

    it('tracks the usage object separately from usageTotalUsd', async () => {
        const withUsage = (reads: number) => ({ ...makeRun(0.2), usage: { DATASET_READS: reads, DATASET_WRITES: 3 } });
        const { deps, firstObservedAt } = setup((ms) => withUsage(ms < 2500 ? 1 : 2) as ActorRun);
        const result = await trackCostStabilization(withUsage(1) as ActorRun, firstObservedAt, options, deps);
        expect(result.signals.usage.present).toBe(true);
        expect(result.signals.usage.changeCount).toBe(1);
        expect(result.signals.usage.stabilizedAfterMs).toBeGreaterThanOrEqual(2500);
        expect(result.signals.usageTotalUsd.changeCount).toBe(0);
        expect(result.finalSnapshot.usage).toEqual({ DATASET_READS: 2, DATASET_WRITES: 3 });
    });

    it('gives up after maxTrackingMillis when cost keeps changing', async () => {
        const { deps, firstObservedAt } = setup((ms) => makeRun(Math.floor(ms / 1000)));
        const result = await trackCostStabilization(makeRun(0), firstObservedAt, options, deps);
        expect(result.stabilized).toBe(false);
        expect(result.trackedForMs).toBeGreaterThanOrEqual(60_000 - 300);
    });

    it('tolerates transient poll errors', async () => {
        const { deps, firstObservedAt } = setup(() => makeRun(0.5));
        let failures = 3;
        const fetchRun = async () => {
            if (failures-- > 0) throw new Error('boom');
            return deps.fetchRun();
        };
        const result = await trackCostStabilization(makeRun(0.5), firstObservedAt, options, { ...deps, fetchRun });
        expect(result.stabilized).toBe(true);
        expect(result.pollErrorCount).toBe(3);
    });
});
