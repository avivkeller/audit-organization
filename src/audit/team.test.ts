import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditTeam, auditTeams } from './team.js';
import * as teamsModule from '../github/teams.js';
import * as restModule from './activity-rest.js';
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
vi.mock('./activity-rest.js', () => ({ probeRepo: vi.fn() }));

const cfg = (overrides: Partial<AuditConfig> = {}): AuditConfig => ({
	org: 'acme',
	token: 't',
	reportRepo: { owner: 'acme', repo: 'audits' },
	inactivityDays: 90,
	since: '2026-01-26T00:00:00Z',
	now: '2026-04-26T00:00:00Z',
	teamMap: { infra: { owner: 'acme', repo: 'infra-board' } },
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
const noActivity = { hasActivity: false, lastSeen: null } as const;
const emptyTeamMap = new Map<string, Set<string>>();

beforeEach(() => {
	vi.mocked(teamsModule.listTeamMembers).mockReset();
	vi.mocked(teamsModule.listTeamRepos).mockReset();
	vi.mocked(restModule.probeRepo).mockReset();
});

describe('auditTeam', () => {
	it('flags members with no activity across all team repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);
		vi.mocked(restModule.probeRepo).mockResolvedValue(noActivity);

		const result = await auditTeam(fakeOctokit, cfg(), 'infra', reportRepo, emptyTeamMap);
		expect(result).not.toBeNull();
		expect(result!.inactive.map((m) => m.login)).toEqual(['alice', 'bob']);
		expect(result!.auditedRepos).toEqual(['acme/infra1']);
	});

	it('short-circuits to active on first hit across repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
			{ owner: 'acme', repo: 'infra2', archived: false },
		]);
		vi.mocked(restModule.probeRepo).mockImplementation(async (_o, _ow, repo) =>
			repo === 'infra1' ? noActivity : { hasActivity: true, lastSeen: '2026-04-01Z' },
		);

		const result = await auditTeam(fakeOctokit, cfg(), 'infra', reportRepo, emptyTeamMap);
		expect(result!.inactive).toEqual([]);
	});

	it('skips archived repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'live', archived: false },
			{ owner: 'acme', repo: 'archived-repo', archived: true },
		]);
		vi.mocked(restModule.probeRepo).mockResolvedValue(noActivity);

		const result = await auditTeam(fakeOctokit, cfg(), 'infra', reportRepo, emptyTeamMap);
		expect(result!.auditedRepos).toEqual(['acme/live']);
		expect(restModule.probeRepo).toHaveBeenCalledTimes(1);
	});

	it('skips ignored repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'live', archived: false },
			{ owner: 'acme', repo: 'legacy', archived: false },
		]);
		vi.mocked(restModule.probeRepo).mockResolvedValue(noActivity);

		const result = await auditTeam(
			fakeOctokit,
			cfg({ ignoreRepositories: new Set(['acme/legacy']) }),
			'infra',
			reportRepo,
			emptyTeamMap,
		);
		expect(result!.auditedRepos).toEqual(['acme/live']);
	});

	it('skips members in ignored teams', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);
		vi.mocked(restModule.probeRepo).mockResolvedValue(noActivity);

		const teamMap = new Map<string, Set<string>>([
			['alice', new Set(['alumni', 'infra'])],
			['bob', new Set(['infra'])],
		]);
		const result = await auditTeam(
			fakeOctokit,
			cfg({ ignoreTeams: new Set(['alumni']) }),
			'infra',
			reportRepo,
			teamMap,
		);
		expect(result!.inactive.map((m) => m.login)).toEqual(['bob']);
	});

	it('returns inactive=all members when team has zero auditable repos', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([]);
		vi.mocked(restModule.probeRepo).mockResolvedValue({ hasActivity: true, lastSeen: null });

		const result = await auditTeam(fakeOctokit, cfg(), 'infra', reportRepo, emptyTeamMap);
		expect(result!.auditedRepos).toEqual([]);
		expect(result!.inactive.map((m) => m.login).sort()).toEqual(['alice', 'bob']);
	});

	it('returns null when listing fails (non-existent team-map repo etc.)', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockImplementation(async () => {
			const e = new Error('Not Found') as Error & { status?: number };
			e.status = 404;
			throw e;
		});
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([]);

		const result = await auditTeam(fakeOctokit, cfg(), 'ghost', reportRepo, emptyTeamMap);
		expect(result).toBeNull();
	});

	it('captures per-member errors without aborting', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'bob']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);
		vi.mocked(restModule.probeRepo).mockImplementation(async (_o, _ow, _r, login) => {
			if (login === 'alice') throw new Error('boom');
			return noActivity;
		});

		const result = await auditTeam(fakeOctokit, cfg(), 'infra', reportRepo, emptyTeamMap);
		expect(result!.errors).toEqual([{ login: 'alice', cause: 'boom' }]);
		expect(result!.inactive.map((m) => m.login)).toEqual(['bob']);
	});

	it('skips bots by default and ignored members', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockResolvedValue(['alice', 'dependabot[bot]', 'carol']);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'infra1', archived: false },
		]);
		vi.mocked(restModule.probeRepo).mockResolvedValue(noActivity);

		const result = await auditTeam(
			fakeOctokit,
			cfg({ ignoreMembers: new Set(['carol']) }),
			'infra',
			reportRepo,
			emptyTeamMap,
		);
		expect(result!.inactive.map((m) => m.login)).toEqual(['alice']);
	});
});

describe('auditTeams', () => {
	it('runs auditTeam once per team-map entry, dropping nulls', async () => {
		vi.mocked(teamsModule.listTeamMembers).mockImplementation(async (_o, _org, slug) =>
			slug === 'infra' ? ['alice'] : ['bob'],
		);
		vi.mocked(teamsModule.listTeamRepos).mockResolvedValue([
			{ owner: 'acme', repo: 'r', archived: false },
		]);
		vi.mocked(restModule.probeRepo).mockResolvedValue(noActivity);

		const results = await auditTeams(
			fakeOctokit,
			cfg({
				teamMap: {
					infra: { owner: 'acme', repo: 'infra-board' },
					data: { owner: 'acme', repo: 'data-board' },
				},
			}),
			emptyTeamMap,
		);
		expect(results.map((r) => r.slug)).toEqual(['infra', 'data']);
	});
});
