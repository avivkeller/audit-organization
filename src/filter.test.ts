import { describe, it, expect } from 'vitest';
import { filterMembers, isBot } from './filter.js';

describe('isBot', () => {
	it('matches GitHub bot login suffix', () => {
		expect(isBot('dependabot[bot]')).toBe(true);
		expect(isBot('renovate[bot]')).toBe(true);
	});

	it('rejects non-bot logins', () => {
		expect(isBot('octocat')).toBe(false);
		expect(isBot('alice')).toBe(false);
		expect(isBot('bot')).toBe(false);
	});
});

describe('filterMembers', () => {
	const cfg = (overrides: Partial<{ ignoreMembers: Set<string>; includeBots: boolean }> = {}) => ({
		ignoreMembers: new Set<string>(),
		includeBots: false,
		...overrides,
	});

	it('drops ignored members', () => {
		expect(filterMembers(['alice', 'bob'], cfg({ ignoreMembers: new Set(['alice']) }))).toEqual([
			'bob',
		]);
	});

	it('drops [bot] logins by default', () => {
		expect(filterMembers(['alice', 'dependabot[bot]'], cfg())).toEqual(['alice']);
	});

	it('keeps bots when includeBots=true', () => {
		expect(filterMembers(['alice', 'dependabot[bot]'], cfg({ includeBots: true }))).toEqual([
			'alice',
			'dependabot[bot]',
		]);
	});

	it('preserves order', () => {
		expect(filterMembers(['c', 'a', 'b'], cfg())).toEqual(['c', 'a', 'b']);
	});
});
