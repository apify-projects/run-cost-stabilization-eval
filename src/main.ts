import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';
import type { Actor as ApifyActor, ActorRun, ActorStartOptions } from 'apify-client';

import { type ResolvedActorInput, resolvePrefilledInput } from './prefill.js';
import { computeStats, type Stats } from './stats.js';
import { type Signal, SIGNALS, trackCostStabilization, type TrackerOptions, type TrackingResult } from './tracker.js';

interface Input {
    actors: string[];
    iterations?: number;
    maxConcurrentRuns?: number;
    inputOverrides?: Record<string, Record<string, unknown>>;
    fastPollIntervalMillis?: number;
    slowPollIntervalMillis?: number;
    slowdownAfterMillis?: number;
    stableWindowMillis?: number;
    maxTrackingMillis?: number;
    runMemoryMbytes?: number;
    runTimeoutSecs?: number;
    runBuild?: string;
    maxTotalChargeUsd?: number;
}

interface RunRecord {
    iteration: number;
    runId: string | null;
    status: string | null;
    pricingModel: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    runDurationMillis: number | null;
    error: string | null;
    tracking: TrackingResult | null;
}

interface ActorState {
    records: RunRecord[];
    done: boolean;
}

interface EvaluationState {
    actors: Record<string, ActorState>;
}

interface ActorContext {
    key: string;
    actor: ApifyActor;
    resolvedInput: ResolvedActorInput;
    runInput: Record<string, unknown>;
    consecutiveErrors: number;
    /** Set when the Actor keeps failing and no more runs should be started. */
    skipRemaining: boolean;
    inFlightRuns: number;
}

/** Stop starting new runs of an Actor after this many consecutive failures to start/finish a run. */
const MAX_CONSECUTIVE_ERRORS = 3;

await Actor.init();

const rawInput = await Actor.getInput<Input>();
if (!rawInput?.actors?.length) throw new Error('Input field "actors" must contain at least one Actor.');

const iterations = rawInput.iterations ?? 50;
const maxConcurrentRuns = rawInput.maxConcurrentRuns ?? 5;
const inputOverrides = rawInput.inputOverrides ?? {};
const trackerOptions: TrackerOptions = {
    fastPollIntervalMillis: rawInput.fastPollIntervalMillis ?? 100,
    slowPollIntervalMillis: rawInput.slowPollIntervalMillis ?? 500,
    slowdownAfterMillis: rawInput.slowdownAfterMillis ?? 2000,
    stableWindowMillis: rawInput.stableWindowMillis ?? 10_000,
    maxTrackingMillis: rawInput.maxTrackingMillis ?? 600_000,
};
const startOptions: ActorStartOptions = {
    build: rawInput.runBuild || undefined,
    memory: rawInput.runMemoryMbytes,
    timeout: rawInput.runTimeoutSecs,
    maxTotalChargeUsd: rawInput.maxTotalChargeUsd,
};
const actorKeys = [...new Set(rawInput.actors.map((a) => a.trim()).filter(Boolean))];

const client = Actor.apifyClient;
const store = await Actor.openKeyValueStore();
const state = await Actor.useState<EvaluationState>('EVALUATION_STATE', { actors: {} });

// Runs that were started but have not finished yet, so we can abort them if we get aborted.
const unfinishedRunIds = new Set<string>();
Actor.on('aborting', async () => {
    log.info(`Aborting, stopping ${unfinishedRunIds.size} unfinished evaluated run(s).`);
    await Promise.allSettled([...unfinishedRunIds].map(async (id) => client.run(id).abort()));
    // Give useState time to persist.
    await sleep(1000);
    await Actor.exit();
});

const detailsKey = (actorKey: string) => `RUNS-${actorKey.replace(/[^a-zA-Z0-9!\-_.'()]/g, '-')}`.slice(0, 256);

async function saveDetails(ctx: ActorContext) {
    await store.setValue(detailsKey(ctx.key), {
        actor: ctx.key,
        actorId: ctx.actor.id,
        inputSource: ctx.resolvedInput.source,
        buildNumber: ctx.resolvedInput.buildNumber,
        runInput: ctx.runInput,
        startOptions,
        trackerOptions,
        runs: state.actors[ctx.key].records,
    });
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of items) counts[keyFn(item)] = (counts[keyFn(item)] ?? 0) + 1;
    return counts;
}

function buildSummary(ctx: ActorContext) {
    const { records } = state.actors[ctx.key];
    const tracked = records.filter((r): r is RunRecord & { tracking: TrackingResult } => r.tracking !== null);
    const stabilized = tracked.filter((r) => r.tracking.stabilized);
    const stabilizationStats = Object.fromEntries(
        SIGNALS.map((signal) => [
            `${signal}StabilizationMs`,
            computeStats(stabilized.map((r) => r.tracking.signals[signal].stabilizedAfterMs)),
        ]),
    ) as Record<`${Signal}StabilizationMs`, Stats>;
    const numbers = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

    return {
        actor: ctx.key,
        actorId: ctx.actor.id,
        actorTitle: ctx.actor.title ?? ctx.actor.name,
        pricingModel: tracked[0]?.pricingModel ?? null,
        inputSource: ctx.resolvedInput.source,
        buildNumber: ctx.resolvedInput.buildNumber,
        runsTotal: records.length,
        runsTracked: tracked.length,
        runsStabilized: stabilized.length,
        runsNotStabilized: tracked.length - stabilized.length,
        runsErrored: records.length - tracked.length,
        runsWithCostChangeAfterFinish: tracked.filter((r) => r.tracking.signals.cost.changeCount > 0).length,
        runStatuses: countBy(tracked, (r) => r.status ?? 'UNKNOWN'),
        // Headline number: time from run finish until usageTotalUsd + chargedEventCounts stopped changing.
        ...stabilizationStats,
        costStabilizationLowerBoundMs: computeStats(
            numbers(stabilized.map((r) => r.tracking.signals.cost.stabilizedAfterLowerBoundMs)),
        ),
        firstSnapshotLagMs: computeStats(tracked.map((r) => r.tracking.firstSnapshotLagMs)),
        costChangeCount: computeStats(tracked.map((r) => r.tracking.signals.cost.changeCount)),
        usageTotalUsdIncreaseAfterFinish: computeStats(
            numbers(
                tracked.map((r) =>
                    r.tracking.finalSnapshot.usageTotalUsd !== null && r.tracking.initialSnapshot.usageTotalUsd !== null
                        ? r.tracking.finalSnapshot.usageTotalUsd - r.tracking.initialSnapshot.usageTotalUsd
                        : null,
                ),
            ),
        ),
        finalUsageTotalUsd: computeStats(numbers(tracked.map((r) => r.tracking.finalSnapshot.usageTotalUsd))),
        finalEventChargeUsd: computeStats(numbers(tracked.map((r) => r.tracking.finalSnapshot.eventChargeUsd))),
        errors: records.filter((r) => r.error).map((r) => ({ iteration: r.iteration, runId: r.runId, error: r.error })),
        detailsKey: detailsKey(ctx.key),
        detailsUrl: store.getPublicUrl(detailsKey(ctx.key)),
    };
}

async function finalizeActor(ctx: ActorContext) {
    const actorState = state.actors[ctx.key];
    if (actorState.done) return;
    actorState.done = true;
    await saveDetails(ctx);
    const summary = buildSummary(ctx);
    await Actor.pushData(summary);
    const cost = summary.costStabilizationMs;
    log.info(
        `[${ctx.key}] done: ${summary.runsStabilized}/${summary.runsTotal} runs stabilized, ` +
            `cost stabilization median ${cost.median} ms, p99 ${cost.p99} ms, max ${cost.max} ms.`,
    );
}

async function evaluateRun(ctx: ActorContext, iteration: number): Promise<RunRecord> {
    const record: RunRecord = {
        iteration,
        runId: null,
        status: null,
        pricingModel: null,
        startedAt: null,
        finishedAt: null,
        runDurationMillis: null,
        error: null,
        tracking: null,
    };
    try {
        const started = await client.actor(ctx.actor.id).start(ctx.runInput, startOptions);
        record.runId = started.id;
        unfinishedRunIds.add(started.id);
        let finished: ActorRun | undefined;
        try {
            finished = await client.run(started.id).waitForFinish();
        } finally {
            unfinishedRunIds.delete(started.id);
        }
        const observedAt = Date.now();
        if (!finished?.finishedAt) throw new Error(`Run ${started.id} did not finish (status ${finished?.status}).`);

        record.status = finished.status;
        record.pricingModel = finished.pricingInfo?.pricingModel ?? 'PAY_PER_USAGE';
        record.startedAt = new Date(finished.startedAt).toISOString();
        record.finishedAt = new Date(finished.finishedAt).toISOString();
        record.runDurationMillis = finished.stats?.durationMillis ?? null;

        record.tracking = await trackCostStabilization(finished, observedAt, trackerOptions, {
            fetchRun: async () => client.run(started.id).get(),
        });
        const { cost } = record.tracking.signals;
        log.info(
            `[${ctx.key}] #${iteration} run ${started.id} ${finished.status}: ` +
                `${record.tracking.stabilized ? 'stabilized' : 'NOT stabilized'} after ${cost.stabilizedAfterMs} ms ` +
                `(${cost.changeCount} change(s), first snapshot lag ${record.tracking.firstSnapshotLagMs} ms).`,
        );
    } catch (err) {
        record.error = (err as Error).message;
        log.exception(err as Error, `[${ctx.key}] #${iteration} run ${record.runId ?? '(not started)'} failed.`);
    }
    return record;
}

// Resolve Actors and their prefilled inputs.
const contexts = new Map<string, ActorContext>();
for (const key of actorKeys) {
    state.actors[key] ??= { records: [], done: false };
    if (state.actors[key].done) continue;
    try {
        const actor = await client.actor(key).get();
        if (!actor) throw new Error(`Actor "${key}" not found.`);
        const resolvedInput = await resolvePrefilledInput(client, actor, startOptions.build);
        const runInput = { ...resolvedInput.input, ...(inputOverrides[key] ?? {}) };
        log.info(`[${key}] Using input from ${resolvedInput.source}: ${JSON.stringify(runInput)}`);
        const ctx: ActorContext = {
            key,
            actor,
            resolvedInput,
            runInput,
            consecutiveErrors: 0,
            skipRemaining: false,
            inFlightRuns: 0,
        };
        contexts.set(key, ctx);
        if (state.actors[key].records.length >= iterations) await finalizeActor(ctx);
    } catch (err) {
        log.exception(err as Error, `[${key}] Cannot evaluate Actor.`);
        state.actors[key].done = true;
        await Actor.pushData({ actor: key, error: (err as Error).message });
    }
}

// Interleave Actors so that all of them make progress in parallel.
const jobs: { ctx: ActorContext; iteration: number }[] = [];
for (let i = 0; i < iterations; i++) {
    for (const ctx of contexts.values()) {
        const alreadyDone = state.actors[ctx.key].records.length;
        if (i >= alreadyDone) jobs.push({ ctx, iteration: i + 1 });
    }
}
log.info(`Evaluating ${contexts.size} Actor(s), ${jobs.length} run(s) to go, ${maxConcurrentRuns} at a time.`);

await Promise.all(
    Array.from({ length: Math.min(maxConcurrentRuns, jobs.length) }, async () => {
        for (let job = jobs.shift(); job; job = jobs.shift()) {
            const { ctx, iteration } = job;
            const actorState = state.actors[ctx.key];
            if (actorState.done || ctx.skipRemaining) continue;

            ctx.inFlightRuns++;
            const record = await evaluateRun(ctx, iteration);
            ctx.inFlightRuns--;
            actorState.records.push(record);
            ctx.consecutiveErrors = record.tracking ? 0 : ctx.consecutiveErrors + 1;
            await saveDetails(ctx);

            if (!ctx.skipRemaining && ctx.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                log.error(`[${ctx.key}] ${ctx.consecutiveErrors} consecutive failed runs, skipping remaining runs.`);
                ctx.skipRemaining = true;
            }
            // Finalize once all runs of this Actor that are still being evaluated have settled.
            if (ctx.inFlightRuns === 0 && (ctx.skipRemaining || actorState.records.length >= iterations)) {
                await finalizeActor(ctx);
            }
        }
    }),
);

await Actor.exit();
