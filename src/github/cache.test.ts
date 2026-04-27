import { describe, it, expect } from 'vitest';
import { emptyCache, isWithinWindow, maxIso, runMarkerFromIso } from './cache.js';

describe('emptyCache', () => {
	it('returns independent empty buckets', () => {
		const a = emptyCache();
		const b = emptyCache();
		a.org.alice = '2026-01-01';
		expect(b.org.alice).toBeUndefined();
	});
});

describe('maxIso', () => {
	it('returns the later of two ISO strings', () => {
		expect(maxIso('2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z')).toBe('2026-04-01T00:00:00Z');
		expect(maxIso('2026-04-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe('2026-04-01T00:00:00Z');
	});
	it('passes through when one side is null/undefined', () => {
		expect(maxIso(null, '2026-04-01T00:00:00Z')).toBe('2026-04-01T00:00:00Z');
		expect(maxIso('2026-04-01T00:00:00Z', null)).toBe('2026-04-01T00:00:00Z');
		expect(maxIso(undefined, undefined)).toBeNull();
	});
});

describe('isWithinWindow', () => {
	it('true when lastSeen >= since', () => {
		expect(isWithinWindow('2026-04-20T00:00:00Z', '2026-01-26T00:00:00Z')).toBe(true);
	});
	it('false when lastSeen < since', () => {
		expect(isWithinWindow('2025-08-01T00:00:00Z', '2026-01-26T00:00:00Z')).toBe(false);
	});
	it('false for null/undefined', () => {
		expect(isWithinWindow(null, '2026-01-26T00:00:00Z')).toBe(false);
		expect(isWithinWindow(undefined, '2026-01-26T00:00:00Z')).toBe(false);
	});
});

describe('runMarkerFromIso', () => {
	it('replaces colons and dots with dashes for cache-key safety', () => {
		expect(runMarkerFromIso('2026-04-26T00:00:00.123Z')).toBe('2026-04-26T00-00-00-123Z');
	});
});
