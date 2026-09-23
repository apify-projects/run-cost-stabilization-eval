export interface Stats {
    count: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
    p75: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
    p99_9: number | null;
}

/**
 * Percentile using linear interpolation between closest ranks (same as numpy's default).
 * `sorted` must be sorted ascending and non-empty.
 */
export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 1) return sorted[0];
    const rank = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function computeStats(values: number[]): Stats {
    if (values.length === 0) {
        return {
            count: 0,
            min: null,
            max: null,
            mean: null,
            median: null,
            p75: null,
            p90: null,
            p95: null,
            p99: null,
            p99_9: null,
        };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
        median: round(percentile(sorted, 50)),
        p75: round(percentile(sorted, 75)),
        p90: round(percentile(sorted, 90)),
        p95: round(percentile(sorted, 95)),
        p99: round(percentile(sorted, 99)),
        p99_9: round(percentile(sorted, 99.9)),
    };
}
