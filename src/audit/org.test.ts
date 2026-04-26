import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditOrg } from './org.js';
import * as graphqlModule from './activity-graphql.js';
import * as commentsModule from './activity-comments.js';
import * as membersModule from '../github/members.js';
import type { AuditConfig, Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

vi.mock('../github/members.js', () => ({ listOrgMembers: vi.fn() }));
vi.mock('./activity-comments.js', () => ({ probeOrgComments: vi.fn() }));
// Partial mock so the pure `activityFromContributions` keeps its real impl.
vi.mock('./activity-graphql.js', async (importActual) => {
	const actual = await importActual<typeof graphqlModule>();
	return {
		...actual,
		fetchOrgId: vi.fn(),
		fetchOrgActivity: vi.fn(),
	};
});

const baseCfg = (overrides: Partial<AuditConfig> = {}): AuditConfig => ({
	org: 'acme',
	token: 't',
	reportRepo: { owner: 'acme', repo: 'audits' },
	inactivityDays: 90,
	since: '2026-01-26T00:00:00Z',
	now: '2026-04-26T00:00:00Z',
	teamMap: {},
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

const ACTIVE_CONTRIBUTIONS = {
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

beforeEach(() => {
	vi.mocked(graphqlModule.fetchOrgId).mockResolvedValue('O_1');
	vi.mocked(commentsModule.probeOrgComments).mockResolvedValue({
		hasActivity: false,
		lastSeen: null,
	});
});

describe('auditOrg', () => {
	it('flags member with no team and no activity as both', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		const result = await auditOrg(fakeOctokit, baseCfg(), new Map());
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

		const result = await auditOrg(fakeOctokit, baseCfg(), new Map([['alice', new Set(['infra'])]]));
		expect(result.inactive[0].reason).toBe('no-activity');
		expect(result.inactive[0].teams).toEqual(['infra']);
	});

	it('flags member with activity but no team as no-team only', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(ACTIVE_CONTRIBUTIONS);

		const result = await auditOrg(fakeOctokit, baseCfg(), new Map());
		expect(result.inactive[0].reason).toBe('no-team');
	});

	it('does not flag active members with teams', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(ACTIVE_CONTRIBUTIONS);

		const result = await auditOrg(fakeOctokit, baseCfg(), new Map([['alice', new Set(['infra'])]]));
		expect(result.inactive).toEqual([]);
	});

	it('skips ignored members', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		await auditOrg(fakeOctokit, baseCfg({ ignoreMembers: new Set(['alice']) }), new Map());
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
		await auditOrg(fakeOctokit, baseCfg({ ignoreTeams: new Set(['alumni']) }), teamMap);
		const audited = vi.mocked(graphqlModule.fetchOrgActivity).mock.calls.map((c) => c[1]);
		expect(audited).toEqual(['bob']);
	});

	it('skips [bot] members by default', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'dependabot[bot]']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		await auditOrg(fakeOctokit, baseCfg(), new Map());
		const audited = vi.mocked(graphqlModule.fetchOrgActivity).mock.calls.map((c) => c[1]);
		expect(audited).toEqual(['alice']);
	});

	it('audits bots when include-bots=true', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice', 'dependabot[bot]']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		await auditOrg(fakeOctokit, baseCfg({ includeBots: true }), new Map());
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

		const result = await auditOrg(fakeOctokit, baseCfg(), new Map());
		expect(result.errors).toEqual([{ login: 'alice', cause: 'boom' }]);
		expect(result.inactive.map((m) => m.login)).toEqual(['bob']);
	});

	it('engages comment probing when interaction-types includes a comment type', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);
		vi.mocked(commentsModule.probeOrgComments).mockResolvedValue({
			hasActivity: true,
			lastSeen: null,
		});

		const result = await auditOrg(
			fakeOctokit,
			baseCfg({ interactionTypes: new Set(['commit', 'issue-comment']) }),
			new Map([['alice', new Set(['infra'])]]),
		);
		expect(commentsModule.probeOrgComments).toHaveBeenCalled();
		expect(result.inactive).toEqual([]);
	});

	it('does NOT call probeOrgComments when comment types are not in interaction-types', async () => {
		vi.mocked(membersModule.listOrgMembers).mockResolvedValue(['alice']);
		vi.mocked(graphqlModule.fetchOrgActivity).mockResolvedValue(null);

		await auditOrg(
			fakeOctokit,
			baseCfg({ interactionTypes: new Set(['commit']) }),
			new Map([['alice', new Set(['infra'])]]),
		);
		expect(commentsModule.probeOrgComments).not.toHaveBeenCalled();
	});
});
