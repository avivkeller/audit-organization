import { describe, it, expect, vi } from 'vitest';
import {
	commentActivity,
	contributionActivity,
	fetchOrgActivity,
	fetchOrgId,
	fetchUserCommentsInOrg,
	repositoriesContributedTo,
	type ContributionsCollection,
	type RepoFilter,
	type UserComment,
} from './graphql.js';
import type { InteractionType, Octokit } from '../types.js';

function makeOctokit(graphql: (q: string, vars: unknown) => Promise<unknown>): Octokit {
	return { graphql } as unknown as Octokit;
}

const types = (...t: InteractionType[]): Set<InteractionType> => new Set(t);

const ALL_TYPES: Set<InteractionType> = new Set(['commit', 'pr', 'pr-review', 'issue']);

// Predicate convenience helpers: org audits use a deny-list (ignore), team
// audits use an allow-list (target). Mirrors the call sites in shared.ts.
const except = (...repos: string[]): RepoFilter => {
	const set = new Set(repos);
	return (r) => !set.has(r);
};
const only = (...repos: string[]): RepoFilter => {
	const set = new Set(repos);
	return (r) => set.has(r);
};
const anyRepo: RepoFilter = () => true;

const emptyCalendar = { weeks: [] };

const baseCollection = (
	overrides: Partial<ContributionsCollection> = {},
): ContributionsCollection => ({
	hasAnyContributions: false,
	totalCommitContributions: 0,
	totalIssueContributions: 0,
	totalPullRequestContributions: 0,
	totalPullRequestReviewContributions: 0,
	contributionCalendar: emptyCalendar,
	commitContributionsByRepository: [],
	issueContributionsByRepository: [],
	pullRequestContributionsByRepository: [],
	pullRequestReviewContributionsByRepository: [],
	...overrides,
});

describe('contributionActivity (deny-list / org-style)', () => {
	it('returns hasActivity=false when contributions is null', () => {
		expect(contributionActivity(null, ALL_TYPES, anyRepo)).toEqual({
			hasActivity: false,
			lastSeen: null,
		});
	});

	it('reports active when any non-ignored repo has a contribution in a requested bucket', () => {
		const c = baseCollection({
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/main' }, contributions: { totalCount: 5 } },
			],
		});
		expect(contributionActivity(c, ALL_TYPES, anyRepo).hasActivity).toBe(true);
	});

	it('treats activity in only-ignored repos as inactive', () => {
		const c = baseCollection({
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/private-fork' }, contributions: { totalCount: 5 } },
			],
		});
		const res = contributionActivity(c, ALL_TYPES, except('acme/private-fork'));
		expect(res.hasActivity).toBe(false);
	});

	it('treats activity in any non-ignored repo as active', () => {
		const c = baseCollection({
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/private-fork' }, contributions: { totalCount: 5 } },
			],
			issueContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/main' }, contributions: { totalCount: 1 } },
			],
		});
		expect(contributionActivity(c, ALL_TYPES, except('acme/private-fork')).hasActivity).toBe(true);
	});

	it('zero counts in any bucket means inactive', () => {
		expect(contributionActivity(baseCollection(), ALL_TYPES, anyRepo).hasActivity).toBe(false);
	});

	it('only inspects buckets for the requested interaction types', () => {
		const c = baseCollection({
			pullRequestReviewContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/main' }, contributions: { totalCount: 1 } },
			],
		});
		// Reviews not requested → inactive even though there is review activity.
		expect(contributionActivity(c, types('commit'), anyRepo).hasActivity).toBe(false);
		expect(contributionActivity(c, types('pr-review'), anyRepo).hasActivity).toBe(true);
	});

	it('extracts lastSeen from the most recent active calendar day', () => {
		const c = baseCollection({
			contributionCalendar: {
				weeks: [
					{
						contributionDays: [
							{ date: '2026-04-15', contributionCount: 2 },
							{ date: '2026-04-16', contributionCount: 0 },
							{ date: '2026-04-17', contributionCount: 5 },
						],
					},
					{
						contributionDays: [{ date: '2026-04-18', contributionCount: 0 }],
					},
				],
			},
		});
		expect(contributionActivity(c, ALL_TYPES, anyRepo).lastSeen).toBe('2026-04-17T23:59:59Z');
	});

	it('returns null lastSeen when no calendar day has contributions', () => {
		const c = baseCollection({
			contributionCalendar: {
				weeks: [{ contributionDays: [{ date: '2026-04-15', contributionCount: 0 }] }],
			},
		});
		expect(contributionActivity(c, ALL_TYPES, anyRepo).lastSeen).toBeNull();
	});
});

describe('contributionActivity (allow-list / team-style)', () => {
	it('returns inactive when contributions is null', () => {
		expect(contributionActivity(null, ALL_TYPES, only('acme/main'))).toEqual({
			hasActivity: false,
			lastSeen: null,
		});
	});

	it('reports active when any target repo has activity in a requested bucket', () => {
		const c = baseCollection({
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/team-repo' }, contributions: { totalCount: 1 } },
			],
		});
		const sig = contributionActivity(c, ALL_TYPES, only('acme/team-repo'));
		expect(sig.hasActivity).toBe(true);
	});

	it('reports inactive when activity is in non-team repos only', () => {
		const c = baseCollection({
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/some-other-repo' }, contributions: { totalCount: 5 } },
			],
		});
		const sig = contributionActivity(c, ALL_TYPES, only('acme/team-repo'));
		expect(sig.hasActivity).toBe(false);
	});

	it('honors interactionTypes', () => {
		const c = baseCollection({
			pullRequestReviewContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/team-repo' }, contributions: { totalCount: 1 } },
			],
		});
		expect(contributionActivity(c, types('commit'), only('acme/team-repo')).hasActivity).toBe(
			false,
		);
		expect(contributionActivity(c, types('pr-review'), only('acme/team-repo')).hasActivity).toBe(
			true,
		);
	});

	it('still surfaces calendar lastSeen even when verdict is inactive', () => {
		const c = baseCollection({
			contributionCalendar: {
				weeks: [{ contributionDays: [{ date: '2026-04-10', contributionCount: 2 }] }],
			},
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/some-other-repo' }, contributions: { totalCount: 5 } },
			],
		});
		const sig = contributionActivity(c, ALL_TYPES, only('acme/team-repo'));
		expect(sig.hasActivity).toBe(false);
		expect(sig.lastSeen).toBe('2026-04-10T23:59:59Z');
	});
});

describe('repositoriesContributedTo', () => {
	it('returns the set of repos with activity in requested types, minus ignored', () => {
		const c = baseCollection({
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/r1' }, contributions: { totalCount: 5 } },
				{ repository: { nameWithOwner: 'acme/private' }, contributions: { totalCount: 1 } },
			],
			issueContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/r2' }, contributions: { totalCount: 1 } },
			],
			pullRequestReviewContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/r3' }, contributions: { totalCount: 1 } },
			],
		});
		expect(repositoriesContributedTo(c, types('commit', 'issue'), except('acme/private'))).toEqual(
			new Set(['acme/r1', 'acme/r2']),
		);
	});

	it('skips zero-count entries', () => {
		const c = baseCollection({
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/r1' }, contributions: { totalCount: 0 } },
			],
		});
		expect(repositoriesContributedTo(c, ALL_TYPES, anyRepo).size).toBe(0);
	});

	it('returns empty set for null contributions', () => {
		expect(repositoriesContributedTo(null, ALL_TYPES, anyRepo).size).toBe(0);
	});
});

describe('fetchOrgId', () => {
	it('returns the org node id', async () => {
		const octokit = makeOctokit(async () => ({ organization: { id: 'O_kgDO123' } }));
		expect(await fetchOrgId(octokit, 'acme')).toBe('O_kgDO123');
	});

	it('throws when org is missing', async () => {
		const octokit = makeOctokit(async () => ({ organization: null }));
		await expect(fetchOrgId(octokit, 'ghost')).rejects.toThrow(/ghost/);
	});
});

describe('fetchOrgActivity', () => {
	it('returns the contributionsCollection block', async () => {
		const expected = baseCollection({ hasAnyContributions: true, totalCommitContributions: 1 });
		const graphql = vi.fn(async () => ({ user: { contributionsCollection: expected } }));
		const result = await fetchOrgActivity(
			makeOctokit(graphql),
			'octocat',
			'O_1',
			'2026-01-01T00:00:00Z',
			'2026-04-26T00:00:00Z',
		);
		expect(result).toEqual(expected);
		expect(graphql).toHaveBeenCalledWith(expect.any(String), {
			login: 'octocat',
			orgId: 'O_1',
			from: '2026-01-01T00:00:00Z',
			to: '2026-04-26T00:00:00Z',
		});
	});

	it('returns null when user is unknown', async () => {
		const octokit = makeOctokit(async () => ({ user: null }));
		const result = await fetchOrgActivity(octokit, 'ghost', 'O_1', 'a', 'b');
		expect(result).toBeNull();
	});
});

describe('commentActivity (deny-list / org-style)', () => {
	const mk = (over: Partial<UserComment>): UserComment => ({
		repo: 'acme/main',
		type: 'issue-comment',
		updatedAt: '2026-04-10T00:00:00Z',
		...over,
	});

	it('reports active when any comment matches a requested type', () => {
		const sig = commentActivity([mk({ type: 'issue-comment' })], types('issue-comment'), anyRepo);
		expect(sig.hasActivity).toBe(true);
	});

	it('discriminates issue-comment vs pr-comment by type', () => {
		const cs = [mk({ type: 'pr-comment' })];
		expect(commentActivity(cs, types('issue-comment'), anyRepo).hasActivity).toBe(false);
		expect(commentActivity(cs, types('pr-comment'), anyRepo).hasActivity).toBe(true);
	});

	it('honors ignoreRepos', () => {
		const sig = commentActivity(
			[mk({ repo: 'acme/private' })],
			types('issue-comment'),
			except('acme/private'),
		);
		expect(sig.hasActivity).toBe(false);
	});

	it('returns the most recent matching updatedAt as lastSeen', () => {
		const sig = commentActivity(
			[
				mk({ updatedAt: '2026-04-10T00:00:00Z' }),
				mk({ updatedAt: '2026-04-15T00:00:00Z' }),
				mk({ updatedAt: '2026-04-12T00:00:00Z' }),
			],
			types('issue-comment'),
			anyRepo,
		);
		expect(sig.lastSeen).toBe('2026-04-15T00:00:00Z');
	});

	it('empty input is inactive with null lastSeen', () => {
		expect(commentActivity([], types('issue-comment'), anyRepo)).toEqual({
			hasActivity: false,
			lastSeen: null,
		});
	});
});

describe('commentActivity (allow-list / team-style)', () => {
	const mk = (over: Partial<UserComment>): UserComment => ({
		repo: 'acme/main',
		type: 'issue-comment',
		updatedAt: '2026-04-10T00:00:00Z',
		...over,
	});

	it('reports active only when comment is in a target repo', () => {
		const cs = [mk({ repo: 'acme/main' }), mk({ repo: 'acme/other' })];
		expect(commentActivity(cs, types('issue-comment'), only('acme/main')).hasActivity).toBe(true);
		expect(commentActivity(cs, types('issue-comment'), only('acme/different')).hasActivity).toBe(
			false,
		);
	});

	it('honors interactionTypes', () => {
		const cs = [mk({ type: 'pr-comment', repo: 'acme/main' })];
		expect(commentActivity(cs, types('issue-comment'), only('acme/main')).hasActivity).toBe(false);
	});
});

describe('fetchUserCommentsInOrg', () => {
	it('filters to org-scoped comments and returns type per pullRequest field', async () => {
		const octokit = makeOctokit(async () => ({
			user: {
				issueComments: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [
						{
							updatedAt: '2026-04-10T00:00:00Z',
							repository: { nameWithOwner: 'acme/main', owner: { login: 'acme' } },
							pullRequest: null,
						},
						{
							updatedAt: '2026-04-09T00:00:00Z',
							repository: { nameWithOwner: 'acme/api', owner: { login: 'acme' } },
							pullRequest: { id: 'PR_1' },
						},
						{
							updatedAt: '2026-04-08T00:00:00Z',
							repository: { nameWithOwner: 'other-org/x', owner: { login: 'other-org' } },
							pullRequest: null,
						},
					],
				},
			},
		}));
		const result = await fetchUserCommentsInOrg(octokit, 'octocat', 'acme', '2026-01-01T00:00:00Z');
		expect(result).toEqual([
			{ repo: 'acme/main', type: 'issue-comment', updatedAt: '2026-04-10T00:00:00Z' },
			{ repo: 'acme/api', type: 'pr-comment', updatedAt: '2026-04-09T00:00:00Z' },
		]);
	});

	it('terminates early once a comment older than `since` is seen (DESC ordering)', async () => {
		const calls: unknown[] = [];
		const octokit = makeOctokit(async (_q, vars) => {
			calls.push(vars);
			return {
				user: {
					issueComments: {
						pageInfo: { hasNextPage: true, endCursor: 'C1' },
						nodes: [
							{
								updatedAt: '2026-04-10T00:00:00Z',
								repository: { nameWithOwner: 'acme/main', owner: { login: 'acme' } },
								pullRequest: null,
							},
							{
								// Older than `since` → terminates the walk.
								updatedAt: '2025-01-01T00:00:00Z',
								repository: { nameWithOwner: 'acme/old', owner: { login: 'acme' } },
								pullRequest: null,
							},
						],
					},
				},
			};
		});
		const result = await fetchUserCommentsInOrg(octokit, 'octocat', 'acme', '2026-01-01T00:00:00Z');
		expect(result.map((c) => c.repo)).toEqual(['acme/main']);
		// Did NOT paginate even though hasNextPage=true.
		expect(calls).toHaveLength(1);
	});

	it('paginates when hasNextPage and no out-of-window comment seen', async () => {
		const octokit = makeOctokit(async (_q, vars) => {
			const cursor = (vars as { cursor: string | null }).cursor;
			if (cursor === null) {
				return {
					user: {
						issueComments: {
							pageInfo: { hasNextPage: true, endCursor: 'C1' },
							nodes: [
								{
									updatedAt: '2026-04-10T00:00:00Z',
									repository: { nameWithOwner: 'acme/r1', owner: { login: 'acme' } },
									pullRequest: null,
								},
							],
						},
					},
				};
			}
			return {
				user: {
					issueComments: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{
								updatedAt: '2026-04-09T00:00:00Z',
								repository: { nameWithOwner: 'acme/r2', owner: { login: 'acme' } },
								pullRequest: null,
							},
						],
					},
				},
			};
		});
		const result = await fetchUserCommentsInOrg(octokit, 'octocat', 'acme', '2026-01-01T00:00:00Z');
		expect(result.map((c) => c.repo)).toEqual(['acme/r1', 'acme/r2']);
	});

	it('returns empty when user is unknown', async () => {
		const octokit = makeOctokit(async () => ({ user: null }));
		expect(await fetchUserCommentsInOrg(octokit, 'ghost', 'acme', '2026-01-01Z')).toEqual([]);
	});
});
