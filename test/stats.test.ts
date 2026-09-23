import { describe, expect, it } from 'vitest';

import { computeStats, percentile } from '../src/stats.js';

describe('percentile', () => {
    it('interpolates between ranks', () => {
        const sorted = [1, 2, 3, 4];
        expect(percentile(sorted, 0)).toBe(1);
        expect(percentile(sorted, 50)).toBe(2.5);
        expect(percentile(sorted, 100)).toBe(4);
    });
});

describe('computeStats', () => {
    it('returns nulls for empty input', () => {
        expect(computeStats([])).toMatchObject({ count: 0, min: null, median: null, p99_9: null });
    });

    it('computes summary over unsorted values', () => {
        const values = Array.from({ length: 101 }, (_, i) => 100 - i);
        expect(computeStats(values)).toEqual({
            count: 101,
            min: 0,
            max: 100,
            mean: 50,
            median: 50,
            p75: 75,
            p90: 90,
            p95: 95,
            p99: 99,
            p99_9: 99.9,
        });
    });
});
