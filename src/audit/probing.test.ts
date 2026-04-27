import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as graphqlModule from './graphql.js';
import { createContext, probeUserActivity, UserProbeCache, type AuditContext } from './probing.js';
import type { AuditConfig, InteractionType, Octokit } from '../types.js';

vi.mock('./graphql.js', async (importActual) => {
	const actual = await importActual<typeof graphqlModule>();
	return {
		...actual,
		fetchOrgId: vi.fn(),
		fetchOrgActivity: vi.fn(),
		fetchUserCommentsInOrg: vi.fn(),
	};
});

const fakeOctokit = {} as Octokit;
const allowAll = () => true;
const t = (...types: InteractionType[]): Set<InteractionType> => new Set(types);

const baseCfg = (overrides: Partial<AuditConfig> = {}): AuditConfig => ({
	org: 'acme',
	token: 'tok',
	reportRepo: { owner: 'acme', repo: 'audits' },
	inactivityDays: 90,
	since: '2026-01-26T00:00:00Z',
	now: '2026-04-26T00:00:00Z',
	dryRun: false,
	ignoreRepositories: new Set(),
	ignoreMembers: new Set(),
	ignoreTeams: new Set(),
	includeOutsideCollaborators: false,
	includeBots: false,
	interactionTypes: t('commit'),
	concurrency: 5,
	...overrides,
});

const emptyCollection = {
	hasAnyContributions: false,
	totalCommitContributions: 0,
	totalIssueContributions: 0,
	totalPullRequestContributions: 0,
	totalPullRequestReviewContributions: 0,
	contributionCalendar: { weeks: [] },
	commitContributionsByRepository: [],
	issueContributionsByRepository: [],
	pullRequestContributionsByRepository: [],
	pullRequestReviewContributionsByRepository: [],
};

const session = (cfg: AuditConfig = baseCfg()): { ctx: AuditContext; cache: UserProbeCache } => {
	const ctx = createContext(fakeOctokit, cfg);
	return { ctx, cache: new UserProbeCache(ctx) };
};

beforeEach(() => {
	vi.mocked(graphqlModule.fetchOrgId).mockReset().mockResolvedValue('O_1');
	vi.mocked(graphqlModule.fetchOrgActivity).mockReset().mockResolvedValue(emptyCollection);
	vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockReset().mockResolvedValue([]);
});

describe('createContext', () => {
	it('memoizes fetchOrgId across calls', async () => {
		const { ctx } = session();
		await Promise.all([ctx.getOrgId(), ctx.getOrgId(), ctx.getOrgId()]);
		expect(graphqlModule.fetchOrgId).toHaveBeenCalledTimes(1);
	});

	it('does not call fetchOrgId until getOrgId is awaited', () => {
		session();
		expect(graphqlModule.fetchOrgId).not.toHaveBeenCalled();
	});
});

describe('UserProbeCache', () => {
	it('shares fetchOrgActivity across repeat callers for the same login', async () => {
		const { cache } = session();
		await Promise.all([cache.getContributions('alice'), cache.getContributions('alice')]);
		await cache.getContributions('alice');
		expect(graphqlModule.fetchOrgActivity).toHaveBeenCalledTimes(1);
	});

	it('issues separate fetches per distinct login', async () => {
		const { cache } = session();
		await Promise.all([cache.getContributions('alice'), cache.getContributions('bob')]);
		expect(graphqlModule.fetchOrgActivity).toHaveBeenCalledTimes(2);
	});

	it('shares fetchUserCommentsInOrg across repeat callers for the same login', async () => {
		const { cache } = session();
		await Promise.all([cache.getComments('alice'), cache.getComments('alice')]);
		expect(graphqlModule.fetchUserCommentsInOrg).toHaveBeenCalledTimes(1);
	});
});

describe('probeUserActivity', () => {
	it('does NOT fetch comments when contributions already prove activity', async () => {
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
			...emptyCollection,
			hasAnyContributions: true,
			totalCommitContributions: 1,
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/main' }, contributions: { totalCount: 1 } },
			],
		});
		const { cache } = session(baseCfg({ interactionTypes: t('commit', 'issue-comment') }));

		const sig = await probeUserActivity(cache, 'alice', allowAll);
		expect(sig.hasActivity).toBe(true);
		expect(graphqlModule.fetchUserCommentsInOrg).not.toHaveBeenCalled();
	});

	it('does NOT fetch comments when no comment type is requested', async () => {
		const { cache } = session(baseCfg({ interactionTypes: t('commit') }));

		const sig = await probeUserActivity(cache, 'alice', allowAll);
		expect(sig.hasActivity).toBe(false);
		expect(graphqlModule.fetchUserCommentsInOrg).not.toHaveBeenCalled();
	});

	it('falls back to comments when contributions are empty and merges lastSeen', async () => {
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
			...emptyCollection,
			contributionCalendar: {
				weeks: [{ contributionDays: [{ date: '2026-04-10', contributionCount: 0 }] }],
			},
		});
		vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockResolvedValue([
			{ repo: 'acme/main', type: 'issue-comment', updatedAt: '2026-04-12T08:00:00Z' },
		]);
		const { cache } = session(baseCfg({ interactionTypes: t('issue-comment') }));

		const sig = await probeUserActivity(cache, 'alice', allowAll);
		expect(sig.hasActivity).toBe(true);
		expect(sig.lastSeen).toBe('2026-04-12T08:00:00Z');
	});

	it('applies the repoFilter to both contributions and comments', async () => {
		// Contributions in non-allowed repo (filtered out), comments in allowed
		// repo should drive the verdict.
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
			...emptyCollection,
			hasAnyContributions: true,
			totalCommitContributions: 1,
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/excluded' }, contributions: { totalCount: 5 } },
			],
		});
		vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockResolvedValue([
			{ repo: 'acme/main', type: 'issue-comment', updatedAt: '2026-04-12T08:00:00Z' },
		]);
		const { cache } = session(baseCfg({ interactionTypes: t('commit', 'issue-comment') }));

		const sig = await probeUserActivity(cache, 'alice', (r) => r === 'acme/main');
		expect(sig.hasActivity).toBe(true);
		expect(sig.lastSeen).toBe('2026-04-12T08:00:00Z');
	});

	it('shares fetches across repeat probes of the same login', async () => {
		// The headline: org probe + N team probes for the same user collapse to
		// one fetchOrgActivity call.
		const { cache } = session();
		await Promise.all([
			probeUserActivity(cache, 'alice', allowAll),
			probeUserActivity(cache, 'alice', (r) => r === 'acme/team-a'),
			probeUserActivity(cache, 'alice', (r) => r === 'acme/team-b'),
		]);
		expect(graphqlModule.fetchOrgActivity).toHaveBeenCalledTimes(1);
	});

	it('shares the comment fallback across repeat probes when triggered', async () => {
		// One audit needs the comment fallback; subsequent probes that also need
		// it should reuse the cached fetch.
		const { cache } = session(baseCfg({ interactionTypes: t('issue-comment') }));
		await Promise.all([
			probeUserActivity(cache, 'alice', allowAll),
			probeUserActivity(cache, 'alice', (r) => r === 'acme/team-a'),
		]);
		expect(graphqlModule.fetchUserCommentsInOrg).toHaveBeenCalledTimes(1);
	});
});
