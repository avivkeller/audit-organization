import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditTeam, auditTeams } from './team.js';
import * as teamsModule from '../github/teams.js';
import * as graphqlModule from './graphql.js';
import { createContext, UserProbeCache } from './probing.js';
import { emptyCache, type ActivityCache } from '../github/cache.js';
import type { AuditConfig, Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

vi.mock('../github/teams.js', () => ({
	buildTeamMap: vi.fn(),
	listTeamMembers: vi.fn(),
	listTeamRepos: vi.fn(),
}));
vi.mock('./graphql.js', async (importActual) => {
	const actual = await importActual<typeof graphqlModule>();
	return {
		...actual,
		fetchOrgId: vi.fn(),
		fetchOrgActivity: vi.fn(),
		fetchUserCommentsInOrg: vi.fn(),
	};
});

const cfg = (overrides: Partial<AuditConfig> = {}): AuditConfig => ({
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
	interactionTypes: new Set(['commit']),
	concurrency: 5,
	...overrides,
});

const fakeOctokit = {} as Octokit;
const reportRepo = { owner: 'acme', repo: 'infra-board' };
const emptyTeamMap = new Map<string, Set<string>>();

const session = (overrides: Partial<AuditConfig> = {}): UserProbeCache =>
	new UserProbeCache(createContext(fakeOctokit, cfg(overrides)));

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

beforeEach(() => {
	vi.mocked(teamsModule.listTeamMembers).mockReset();
	vi.mocked(teamsModule.listTeamRepos).mockReset();
	vi.mocked(graphqlModule.fetchOrgId).mockReset().mockResolvedValue('O_1');
	vi.mocked(graphqlModule.fetchOrgActivity).mockReset().mockResolvedValue(emptyCollection);
	vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockReset().mockResolvedValue([]);
});

describe('auditTeam', () => {
	it('flags members as inactive when contributionsCollection shows no in-window activity', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);

		const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, emptyCache());
		expect(result).not.toBeNull();
		expect(result!.inactive.map((m) => m.login)).toEqual(['alice', 'bob']);
		expect(result!.auditedRepos).toEqual(['acme/infra1']);
	});

	it('marks members active when contributionsCollection shows window activity in a team repo', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
			...emptyCollection,
			hasAnyContributions: true,
			totalCommitContributions: 1,
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/infra1' }, contributions: { totalCount: 1 } },
			],
		});

		const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, emptyCache());
		expect(result!.inactive).toEqual([]);
	});

	it('marks members inactive when activity is in non-team repos only', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
			...emptyCollection,
			hasAnyContributions: true,
			totalCommitContributions: 1,
			commitContributionsByRepository: [
				{ repository: { nameWithOwner: 'acme/other' }, contributions: { totalCount: 1 } },
			],
		});

		const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, emptyCache());
		expect(result!.inactive.map((m) => m.login)).toEqual(['alice']);
	});

	it('skips archived repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'live', archived: false },
			{ owner: 'acme', repo: 'archived-repo', archived: true },
		]);

		const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, emptyCache());
		expect(result!.auditedRepos).toEqual(['acme/live']);
	});

	it('skips ignored repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'live', archived: false },
			{ owner: 'acme', repo: 'legacy', archived: false },
		]);

		const result = await auditTeam(
			session({ ignoreRepositories: new Set(['acme/legacy']) }),
			'infra',
			reportRepo,
			emptyTeamMap,
			emptyCache(),
		);
		expect(result!.auditedRepos).toEqual(['acme/live']);
	});

	it('skips members in ignored teams', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);

		const teamMap = new Map<string, Set<string>>([
			['alice', new Set(['alumni', 'infra'])],
			['bob', new Set(['infra'])],
		]);
		const result = await auditTeam(
			session({ ignoreTeams: new Set(['alumni']) }),
			'infra',
			reportRepo,
			teamMap,
			emptyCache(),
		);
		expect(result!.inactive.map((m) => m.login)).toEqual(['bob']);
	});

	it('returns inactive=all members when team has zero auditable repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([]);

		const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, emptyCache());
		expect(result!.auditedRepos).toEqual([]);
		expect(result!.inactive.map((m) => m.login).sort()).toEqual(['alice', 'bob']);
		expect(graphqlModule.fetchOrgActivity).not.toHaveBeenCalled();
	});

	it('returns null when listing fails (non-existent team-map repo etc.)', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockImplementation(async () => {
			const e = new Error('Not Found') as Error & { status?: number };
			e.status = 404;
			throw e;
		});
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([]);

		const result = await auditTeam(session(), 'ghost', reportRepo, emptyTeamMap, emptyCache());
		expect(result).toBeNull();
	});

	it('captures per-member errors without aborting', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);
		vi.mocked(graphqlModule.fetchOrgActivity).mockImplementation(async (_o, login) => {
			if (login === 'alice') throw new Error('boom');
			return emptyCollection;
		});

		const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, emptyCache());
		expect(result!.errors).toEqual([{ login: 'alice', cause: 'boom' }]);
		expect(result!.inactive.map((m) => m.login)).toEqual(['bob']);
	});

	it('skips bots by default and ignored members', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'dependabot[bot]', 'carol']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);

		const result = await auditTeam(
			session({ ignoreMembers: new Set(['carol']) }),
			'infra',
			reportRepo,
			emptyTeamMap,
			emptyCache(),
		);
		expect(result!.inactive.map((m) => m.login)).toEqual(['alice']);
	});

	describe('comment fallback', () => {
		it('detects comment-only contributors when a comment type is enabled', async () => {
			// Comment-only contributors don't appear in contributionsCollection,
			// so an empty collection alone must not mark them inactive - the audit
			// must reach the comment probe.
			vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
			vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
				{ owner: 'acme', repo: 'r1', archived: false },
			]);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(emptyCollection);
			vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockResolvedValue([
				{ repo: 'acme/r1', type: 'issue-comment', updatedAt: '2026-04-10T00:00:00Z' },
			]);

			const result = await auditTeam(
				session({ interactionTypes: new Set(['commit', 'issue-comment']) }),
				'infra',
				reportRepo,
				emptyTeamMap,
				emptyCache(),
			);
			expect(result!.inactive).toEqual([]);
		});

		it('marks members inactive when comments are in non-team repos', async () => {
			vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
			vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
				{ owner: 'acme', repo: 'r1', archived: false },
			]);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(emptyCollection);
			vi.mocked(graphqlModule.fetchUserCommentsInOrg).mockResolvedValue([
				{ repo: 'acme/other', type: 'issue-comment', updatedAt: '2026-04-10T00:00:00Z' },
			]);

			const result = await auditTeam(
				session({ interactionTypes: new Set(['issue-comment']) }),
				'infra',
				reportRepo,
				emptyTeamMap,
				emptyCache(),
			);
			expect(result!.inactive.map((m) => m.login)).toEqual(['alice']);
		});

		it('does NOT call fetchUserCommentsInOrg when contributionsCollection already proves activity', async () => {
			vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
			vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
				{ owner: 'acme', repo: 'r1', archived: false },
			]);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
				...emptyCollection,
				hasAnyContributions: true,
				totalCommitContributions: 1,
				commitContributionsByRepository: [
					{ repository: { nameWithOwner: 'acme/r1' }, contributions: { totalCount: 1 } },
				],
			});

			await auditTeam(
				session({ interactionTypes: new Set(['commit', 'issue-comment']) }),
				'infra',
				reportRepo,
				emptyTeamMap,
				emptyCache(),
			);
			expect(graphqlModule.fetchUserCommentsInOrg).not.toHaveBeenCalled();
		});
	});

	describe('with @actions/cache', () => {
		it('skips probes when cache proves member is active inside the window', async () => {
			vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
			vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
				{ owner: 'acme', repo: 'r1', archived: false },
				{ owner: 'acme', repo: 'r2', archived: false },
			]);
			const persisted: ActivityCache = {
				org: {},
				teams: { infra: { alice: '2026-04-20T00:00:00Z' } },
			};

			const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, persisted);
			expect(graphqlModule.fetchOrgActivity).not.toHaveBeenCalled();
			expect(result!.inactive).toEqual([]);
		});

		it('updates the team cache with the freshest observed lastSeen', async () => {
			vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
			vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
				{ owner: 'acme', repo: 'r1', archived: false },
			]);
			vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue({
				...emptyCollection,
				hasAnyContributions: true,
				totalCommitContributions: 1,
				contributionCalendar: {
					weeks: [{ contributionDays: [{ date: '2026-04-15', contributionCount: 2 }] }],
				},
				commitContributionsByRepository: [
					{ repository: { nameWithOwner: 'acme/r1' }, contributions: { totalCount: 1 } },
				],
			});
			const persisted: ActivityCache = {
				org: {},
				teams: { infra: { alice: '2025-12-01T00:00:00Z' } },
			};

			await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, persisted);
			expect(persisted.teams.infra.alice).toBe('2026-04-15T23:59:59Z');
		});

		it('reports cached lastSeen when probe finds nothing - even when older than the window', async () => {
			vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
			vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
				{ owner: 'acme', repo: 'r1', archived: false },
			]);
			const persisted: ActivityCache = {
				org: {},
				teams: { infra: { alice: '2024-06-15T00:00:00Z' } },
			};

			const result = await auditTeam(session(), 'infra', reportRepo, emptyTeamMap, persisted);
			expect(result!.inactive[0].lastSeen).toBe('2024-06-15T00:00:00Z');
		});
	});
});

describe('auditTeams', () => {
	const discovery = (entries: Array<[string, { owner: string; repo: string }]>) => ({
		membership: emptyTeamMap,
		reportRepos: new Map(entries),
	});

	it('runs auditTeam once per discovered team, dropping nulls', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockImplementation(async (_o, _org, slug) =>
			slug === 'infra' ? ['alice'] : ['bob'],
		);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'r', archived: false },
		]);

		const results = await auditTeams(
			session(),
			discovery([
				['infra', { owner: 'acme', repo: 'infra-board' }],
				['data', { owner: 'acme', repo: 'data-board' }],
			]),
			emptyCache(),
		);
		expect(results.map((r) => r.slug)).toEqual(['infra', 'data']);
	});

	it('shares a single fetchOrgId call across all team audits', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'r1', archived: false },
		]);

		await auditTeams(
			session(),
			discovery([
				['infra', { owner: 'acme', repo: 'infra-board' }],
				['data', { owner: 'acme', repo: 'data-board' }],
			]),
			emptyCache(),
		);
		expect(graphqlModule.fetchOrgId).toHaveBeenCalledTimes(1);
	});

	it('skips fetchOrgId entirely when no team has auditable repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([]);

		await auditTeams(
			session(),
			discovery([['infra', { owner: 'acme', repo: 'infra-board' }]]),
			emptyCache(),
		);
		expect(graphqlModule.fetchOrgId).not.toHaveBeenCalled();
	});

	it('shares fetchOrgActivity across teams when a member appears in multiple teams', async () => {
		// Headline dedup property: if Alice is on team-a AND team-b, we hit the
		// API exactly once for her contributions, not once per team.
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'r1', archived: false },
		]);

		await auditTeams(
			session(),
			discovery([
				['team-a', { owner: 'acme', repo: 'a-board' }],
				['team-b', { owner: 'acme', repo: 'b-board' }],
			]),
			emptyCache(),
		);
		expect(graphqlModule.fetchOrgActivity).toHaveBeenCalledTimes(1);
	});
});
