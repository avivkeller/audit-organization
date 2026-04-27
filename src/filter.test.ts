import { describe, it, expect } from 'vitest';
import { filterMembers, intersectsIgnored, isBot, wantsCommentSignal } from './filter.js';
import type { InteractionType } from './types.js';

const t = (...types: InteractionType[]): Set<InteractionType> => new Set(types);

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

describe('intersectsIgnored', () => {
	it('returns the first ignored team a user belongs to', () => {
		expect(intersectsIgnored(new Set(['infra', 'alumni']), new Set(['alumni']))).toBe('alumni');
	});

	it('returns null when user is not in any ignored team', () => {
		expect(intersectsIgnored(new Set(['infra']), new Set(['alumni']))).toBeNull();
	});

	it('returns null for empty user teams', () => {
		expect(intersectsIgnored(new Set(), new Set(['alumni']))).toBeNull();
	});
});

describe('wantsCommentSignal', () => {
	it('is true when issue-comment is requested', () => {
		expect(wantsCommentSignal(t('issue-comment'))).toBe(true);
	});

	it('is true when pr-comment is requested', () => {
		expect(wantsCommentSignal(t('pr-comment'))).toBe(true);
	});

	it('is false when only non-comment types are requested', () => {
		expect(wantsCommentSignal(t('commit', 'pr', 'pr-review', 'issue'))).toBe(false);
	});
});
