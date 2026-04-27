import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import { run } from './main.js';
import * as inputsModule from './inputs.js';
import * as octokitModule from './octokit.js';
import * as orgModule from './audit/org.js';
import * as teamModule from './audit/team.js';
import * as teamsModule from './github/teams.js';
import * as issueModule from './github/issue.js';
import * as cacheModule from './github/cache.js';
import type { AuditConfig, Octokit, OrgAuditResult, TeamAuditResult } from './types.js';

vi.mock('@actions/core', () => ({
	getInput: vi.fn(),
	setOutput: vi.fn(),
	setFailed: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

vi.mock('./inputs.js', () => ({ parseInputs: vi.fn() }));
vi.mock('./octokit.js', () => ({ buildClient: vi.fn() }));
vi.mock('./audit/org.js', () => ({ auditOrg: vi.fn() }));
vi.mock('./audit/team.js', () => ({ auditTeams: vi.fn() }));
vi.mock('./github/teams.js', () => ({
	buildTeamMap: vi.fn(),
	listTeamMembers: vi.fn(),
	listTeamRepos: vi.fn(),
}));
vi.mock('./github/issue.js', () => ({ upsertIssue: vi.fn() }));
vi.mock('./github/cache.js', async (importActual) => {
	const actual = await importActual<typeof cacheModule>();
	return {
		...actual,
		restoreActivityCache: vi.fn(),
		saveActivityCache: vi.fn(),
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

const orgResult: OrgAuditResult = {
	org: 'acme',
	totalAudited: 5,
	inactive: [{ login: 'alice', reason: 'no-activity', teams: ['infra'], lastSeen: null }],
	errors: [],
	noTeamCount: 0,
	noActivityCount: 1,
	bothCount: 0,
	runAt: '2026-04-26T00:00:00Z',
};

const emptyDiscovery = () => ({
	membership: new Map<string, Set<string>>(),
	reportRepos: new Map<string, { owner: string; repo: string }>(),
});

beforeEach(() => {
	vi.mocked(octokitModule.buildClient).mockReturnValue({} as Octokit);
	vi.mocked(teamsModule.buildTeamMap).mockResolvedValue(emptyDiscovery());
	vi.mocked(orgModule.auditOrg).mockResolvedValue(orgResult);
	vi.mocked(teamModule.auditTeams).mockResolvedValue([]);
	vi.mocked(issueModule.upsertIssue).mockResolvedValue({
		url: 'https://x/issues/1',
		number: 1,
		action: 'created',
	});
	vi.mocked(cacheModule.restoreActivityCache).mockResolvedValue({ org: {}, teams: {} });
	vi.mocked(cacheModule.saveActivityCache).mockResolvedValue(undefined);
});

describe('run', () => {
	it('parses inputs, runs org audit, files org issue, sets outputs', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(cfg());

		await run();

		expect(teamsModule.buildTeamMap).toHaveBeenCalledTimes(1);
		expect(orgModule.auditOrg).toHaveBeenCalledTimes(1);
		expect(issueModule.upsertIssue).toHaveBeenCalledTimes(1);
		expect(teamModule.auditTeams).not.toHaveBeenCalled();
		expect(core.setOutput).toHaveBeenCalledWith('inactive-count', '1');
		expect(core.setOutput).toHaveBeenCalledWith('issue-url', 'https://x/issues/1');
	});

	it('passes membership to org audit and the full discovery to team audits', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(cfg());
		const sharedDiscovery = {
			membership: new Map<string, Set<string>>([['alice', new Set(['infra'])]]),
			reportRepos: new Map([['infra', { owner: 'acme', repo: 'infra-board' }]]),
		};
		vi.mocked(teamsModule.buildTeamMap).mockResolvedValue(sharedDiscovery);

		await run();

		expect(vi.mocked(orgModule.auditOrg).mock.calls[0][1]).toBe(sharedDiscovery.membership);
		expect(vi.mocked(teamModule.auditTeams).mock.calls[0][1]).toBe(sharedDiscovery);
	});

	it('restores cache before audits and saves after - even on failure', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(cfg());
		const restored = { org: { alice: '2026-04-20T00:00:00Z' }, teams: {} };
		vi.mocked(cacheModule.restoreActivityCache).mockResolvedValue(restored);

		await run();

		expect(cacheModule.restoreActivityCache).toHaveBeenCalledWith('acme', expect.any(String));
		expect(vi.mocked(orgModule.auditOrg).mock.calls[0][2]).toBe(restored);
		expect(cacheModule.saveActivityCache).toHaveBeenCalledWith(
			'acme',
			expect.any(String),
			restored,
		);
	});

	it('saves cache even when the audit throws', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(cfg());
		vi.mocked(orgModule.auditOrg).mockRejectedValue(new Error('boom'));

		await expect(run()).rejects.toThrow('boom');
		expect(cacheModule.saveActivityCache).toHaveBeenCalled();
	});

	it('runs per-team audits when discovery surfaces at least one team report-repo', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(cfg());
		vi.mocked(teamsModule.buildTeamMap).mockResolvedValue({
			membership: new Map(),
			reportRepos: new Map([['infra', { owner: 'acme', repo: 'infra-board' }]]),
		});
		const teamResult: TeamAuditResult = {
			slug: 'infra',
			reportRepo: { owner: 'acme', repo: 'infra-board' },
			totalAudited: 2,
			inactive: [],
			auditedRepos: ['acme/r1'],
			errors: [],
			runAt: '2026-04-26T00:00:00Z',
		};
		vi.mocked(teamModule.auditTeams).mockResolvedValue([teamResult]);

		await run();

		expect(issueModule.upsertIssue).toHaveBeenCalledTimes(2);
		const callRepos = vi.mocked(issueModule.upsertIssue).mock.calls.map((c) => c[1].repo);
		expect(callRepos).toEqual(['audits', 'infra-board']);
	});

	it('passes dryRun through to upsertIssue', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(cfg({ dryRun: true }));

		await run();

		expect(vi.mocked(issueModule.upsertIssue).mock.calls[0][1]).toMatchObject({ dryRun: true });
	});
});
