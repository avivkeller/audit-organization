import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditOrg } from './org.js';
import * as graphqlModule from './graphql.js';
import * as membersModule from '../github/members.js';
import { createContext, UserProbeCache } from './probing.js';
import { emptyCache, type ActivityCache } from '../github/cache.js';
import type { AuditConfig, Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

vi.mock('../github/members.js', () => ({ listOrgMembers: vi.fn() }));
// Partial mock so the pure helpers (activityFromContributions etc.) keep their
// real impl while the network-touching functions are stubbed.
vi.mock('./graphql.js', async (importActual) => {
	const actual = await importActual<typeof graphqlModule>();
	return {
		...actual,
		fetchOrgId: vi.fn(),
		fetchOrgActivity: vi.fn(),
		fetchUserCommentsInOrg: vi.fn(),
	};
});

const baseCfg = (overrides: Partial<AuditConfig> = {}): AuditConfig => ({
	org: 'acme',
	token: 't',
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
	interactionTypes: new Set(['commit', 'pr', 'pr-review', 'issue']),
	concurrency: 5,
	...overrides,
});

const fakeOctokit = {} as Octokit;

const session = (overrides: Partial<AuditConfig> = {}): UserProbeCache =>
	new UserProbeCache(createContext(fakeOctokit, baseCfg(overrides)));

const ACTIVE_CONTRIBUTIONS = {
	hasAnyContributions: true,
	totalCommitContributions: 1,
	totalIssueContributions: 0,
	totalPullRequestContributions: 0,
	totalPullRequestReviewContributions: 0,
	contributionCalendar: { weeks: [] },
	commitContributionsByRepository: [
		{ repository: { nameWithOwner: 'acme/main' }, contributions: { totalCount: 1 } },
	],
	issueContributionsByRepository: [],
	pullRequestContributionsByRepository: [],
	pullRequestReviewContributionsByRepository: [],
};

beforeEach(() => {
	vi.mocked(graphqlModule.fetchOrgId).mockResolvedValue('O_1');
	vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockResolvedValue([]);
});

describe('auditOrg', () => {
	it('flags member with no team and no activity as both', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		const result = await auditOrg(session(), new Map(), emptyCache());
		expect(result.inactive).toEqual([
			{ login: 'alice', reason: 'no-activity, no-team', teams: [], lastSeen: null },
		]);
		expect(result.bothCount).toBe(1);
		expect(result.noTeamCount).toBe(1);
		expect(result.noActivityCount).toBe(1);
	});

	it('flags member with team but no activity as no-activity only', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		const result = await auditOrg(
			session(),
			new Map([['alice', new Set(['infra'])]]),
			emptyCache(),
		);
		expect(result.inactive[0].reason).toBe('no-activity');
		expect(result.inactive[0].teams).toEqual(['infra']);
	});

	it('flags member with activity but no team as no-team only', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(ACTIVE_CONTRIBUTIONS);

		const result = await auditOrg(session(), new Map(), emptyCache());
		expect(result.inactive[0].reason).toBe('no-team');
	});

	it('does not flag active members with teams', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(ACTIVE_CONTRIBUTIONS);

		const result = await auditOrg(
			session(),
			new Map([['alice', new Set(['infra'])]]),
			emptyCache(),
		);
		expect(result.inactive).toEqual([]);
	});

	it('skips ignored members', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		await auditOrg(session({ ignoreMembers: new Set(['alice']) }), new Map(), emptyCache());
		const audited = vi.mocked(graphqlModule.fetchOrgActivity).mock.calls.map((c) => c[1]);
		expect(audited).toEqual(['bob']);
	});

	it('skips members of ignored teams', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		const teamMap = new Map<string, Set<string>>([
			['alice', new Set(['alumni'])],
			['bob', new Set(['infra'])],
		]);
		await auditOrg(session({ ignoreTeams: new Set(['alumni']) }), teamMap, emptyCache());
		const audited = vi.mocked(graphqlModule.fetchOrgActivity).mock.calls.map((c) => c[1]);
		expect(audited).toEqual(['bob']);
	});

	it('skips [bot] members by default', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'dependabot[bot]']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		await auditOrg(session(), new Map(), emptyCache());
		const audited = vi.mocked(graphqlModule.fetchOrgActivity).mock.calls.map((c) => c[1]);
		expect(audited).toEqual(['alice']);
	});

	it('audits bots when include-bots=true', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'dependabot[bot]']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		await auditOrg(session({ includeBots: true }), new Map(), emptyCache());
		const audited = vi
			.mocked(graphqlModule.fetchOrgActivity)
			.mock.calls.map((c) => c[1])
			.sort();
		expect(audited).toEqual(['alice', 'dependabot[bot]']);
	});

	it('captures errors per-member without aborting the run', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockImplementation(async (_o, login) => {
			if (login === 'alice') throw new Error('boom');
			return null;
		});

		const result = await auditOrg(session(), new Map(), emptyCache());
		expect(result.errors).toEqual([{ login: 'alice', cause: 'boom' }]);
		expect(result.inactive.map((m) => m.login)).toEqual(['bob']);
	});

	describe('comment fallback', () => {
		it('probes comments when contributionsCollection is empty and a comment type is enabled', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);
			vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockResolvedValue([
				{ repo: 'acme/main', type: 'issue-comment', updatedAt: '2026-04-10T00:00:00Z' },
			]);

			const result = await auditOrg(
				session({ interactionTypes: new Set(['commit', 'issue-comment']) }),
				new Map([['alice', new Set(['infra'])]]),
				emptyCache(),
			);
			expect(graphqlModule.fetchUserCommentsInOrg).toHaveBeenCalled();
			expect(result.inactive).toEqual([]);
		});

		it('does NOT call fetchUserCommentsInOrg when no comment type is enabled', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

			await auditOrg(
				session({ interactionTypes: new Set(['commit']) }),
				new Map([['alice', new Set(['infra'])]]),
				emptyCache(),
			);
			expect(graphqlModule.fetchUserCommentsInOrg).not.toHaveBeenCalled();
		});

		it('does NOT call fetchUserCommentsInOrg when contributionsCollection already shows activity', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(ACTIVE_CONTRIBUTIONS);

			await auditOrg(
				session({ interactionTypes: new Set(['commit', 'issue-comment']) }),
				new Map([['alice', new Set(['infra'])]]),
				emptyCache(),
			);
			expect(graphqlModule.fetchUserCommentsInOrg).not.toHaveBeenCalled();
		});

		it('records the comment updatedAt as lastSeen in the cache', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);
			vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockResolvedValue([
				{ repo: 'acme/main', type: 'pr-comment', updatedAt: '2026-04-12T08:00:00Z' },
			]);
			const persisted = emptyCache();
			await auditOrg(
				session({ interactionTypes: new Set(['pr-comment']) }),
				new Map([['alice', new Set(['infra'])]]),
				persisted,
			);
			expect(persisted.org.alice).toBe('2026-04-12T08:00:00Z');
		});
	});

	describe('with @actions/cache', () => {
		it('skips probe when cache proves member is active inside the window', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			const persisted: ActivityCache = { org: { alice: '2026-04-20T00:00:00Z' }, teams: {} };
			// since=2026-01-26, alice cached at 2026-04-20 => active without probe.

			const result = await auditOrg(session(), new Map([['alice', new Set(['infra'])]]), persisted);
			expect(graphqlModule.fetchOrgActivity).not.toHaveBeenCalled();
			expect(graphqlModule.fetchOrgId).not.toHaveBeenCalled();
			expect(result.inactive).toEqual([]);
		});

		it('falls back to probe when cached lastSeen is older than the window', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);
			const persisted: ActivityCache = { org: { alice: '2025-08-01T00:00:00Z' }, teams: {} };

			const result = await auditOrg(session(), new Map([['alice', new Set(['infra'])]]), persisted);
			expect(graphqlModule.fetchOrgActivity).toHaveBeenCalled();
			// Probe found nothing, so the report falls back to the (stale) cached value.
			expect(result.inactive[0].lastSeen).toBe('2025-08-01T00:00:00Z');
		});

		it('updates the cache with the freshest observed lastSeen', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
				hasAnyContributions: true,
				totalCommitContributions: 1,
				totalIssueContributions: 0,
				totalPullRequestContributions: 0,
				totalPullRequestReviewContributions: 0,
				contributionCalendar: {
					weeks: [
						{
							contributionDays: [
								{ date: '2026-04-15', contributionCount: 2 },
								{ date: '2026-04-16', contributionCount: 0 },
							],
						},
					],
				},
				commitContributionsByRepository: [
					{ repository: { nameWithOwner: 'acme/main' }, contributions: { totalCount: 2 } },
				],
				issueContributionsByRepository: [],
				pullRequestContributionsByRepository: [],
				pullRequestReviewContributionsByRepository: [],
			});
			const persisted: ActivityCache = { org: { alice: '2025-12-01T00:00:00Z' }, teams: {} };

			await auditOrg(session(), new Map([['alice', new Set(['infra'])]]), persisted);
			expect(persisted.org.alice).toBe('2026-04-15T23:59:59Z');
		});

		it('does not call fetchOrgId when every candidate is cache-resolved', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'bob']);
			const persisted: ActivityCache = {
				org: { alice: '2026-04-20T00:00:00Z', bob: '2026-04-21T00:00:00Z' },
				teams: {},
			};

			await auditOrg(
				session(),
				new Map([
					['alice', new Set(['infra'])],
					['bob', new Set(['infra'])],
				]),
				persisted,
			);
			expect(graphqlModule.fetchOrgId).not.toHaveBeenCalled();
		});

		it('reports cached lastSeen even when the timestamp predates the window', async () => {
			vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);
			const persisted: ActivityCache = { org: { alice: '2024-06-15T00:00:00Z' }, teams: {} };

			const result = await auditOrg(session(), new Map([['alice', new Set(['infra'])]]), persisted);
			expect(result.inactive[0].lastSeen).toBe('2024-06-15T00:00:00Z');
		});
	});
});
