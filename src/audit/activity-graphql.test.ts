import { describe, it, expect, vi } from 'vitest';
import { activityFromContributions, fetchOrgActivity, fetchOrgId } from './activity-graphql.js';
import type { Octokit } from '../types.js';

function makeOctokit(graphql: (q: string, vars: unknown) => Promise<unknown>): Octokit {
	return { graphql } as unknown as Octokit;
}

describe('activityFromContributions', () => {
	it('returns hasActivity=false when contributions is null', () => {
		expect(activityFromContributions(null, new Set())).toEqual({
			hasActivity: false,
			lastSeen: null,
		});
	});

	it('uses hasAnyContributions fast-path when no ignore list', () => {
		const c = {
			hasAnyContributions: true,
			totalCommitContributions: 0,
			totalIssueContributions: 0,
			totalPullRequestContributions: 0,
			totalPullRequestReviewContributions: 0,
			commitContributionsByRepository: [],
			issueContributionsByRepository: [],
			pullRequestContributionsByRepository: [],
			pullRequestReviewContributionsByRepository: [],
		};
		expect(activityFromContributions(c, new Set()).hasActivity).toBe(true);
	});

	it('treats activity in only-ignored repos as inactive', () => {
		const c = {
			hasAnyContributions: true,
			totalCommitContributions: 5,
			totalIssueContributions: 0,
			totalPullRequestContributions: 0,
			totalPullRequestReviewContributions: 0,
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/private-fork' }, contributions: { totalCount: 5 } },
			],
			issueContributionsByRepository: [],
			pullRequestContributionsByRepository: [],
			pullRequestReviewContributionsByRepository: [],
		};
		const res = activityFromContributions(c, new Set(['acme/private-fork']));
		expect(res.hasActivity).toBe(false);
	});

	it('treats activity in any non-ignored repo as active', () => {
		const c = {
			hasAnyContributions: true,
			totalCommitContributions: 5,
			totalIssueContributions: 1,
			totalPullRequestContributions: 0,
			totalPullRequestReviewContributions: 0,
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/private-fork' }, contributions: { totalCount: 5 } },
			],
			issueContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/main' }, contributions: { totalCount: 1 } },
			],
			pullRequestContributionsByRepository: [],
			pullRequestReviewContributionsByRepository: [],
		};
		expect(activityFromContributions(c, new Set(['acme/private-fork'])).hasActivity).toBe(true);
	});

	it('zero counts in any bucket means inactive', () => {
		const c = {
			hasAnyContributions: false,
			totalCommitContributions: 0,
			totalIssueContributions: 0,
			totalPullRequestContributions: 0,
			totalPullRequestReviewContributions: 0,
			commitContributionsByRepository: [],
			issueContributionsByRepository: [],
			pullRequestContributionsByRepository: [],
			pullRequestReviewContributionsByRepository: [],
		};
		expect(activityFromContributions(c, new Set()).hasActivity).toBe(false);
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
		const expected = {
			hasAnyContributions: true,
			totalCommitContributions: 1,
			totalIssueContributions: 0,
			totalPullRequestContributions: 0,
			totalPullRequestReviewContributions: 0,
			commitContributionsByRepository: [],
			issueContributionsByRepository: [],
			pullRequestContributionsByRepository: [],
			pullRequestReviewContributionsByRepository: [],
		};
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
