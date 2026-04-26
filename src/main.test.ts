import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import { run } from './main.js';
import * as inputsModule from './inputs.js';
import * as octokitModule from './octokit.js';
import * as orgModule from './audit/org.js';
import * as teamModule from './audit/team.js';
import * as teamsModule from './github/teams.js';
import * as issueModule from './github/issue.js';
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

const cfg = (overrides: Partial<AuditConfig> = {}): AuditConfig => ({
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

beforeEach(() => {
	vi.mocked(octokitModule.buildClient).mockReturnValue({} as Octokit);
	vi.mocked(teamsModule.buildTeamMap).mockResolvedValue(new Map());
	vi.mocked(orgModule.auditOrg).mockResolvedValue(orgResult);
	vi.mocked(teamModule.auditTeams).mockResolvedValue([]);
	vi.mocked(issueModule.upsertIssue).mockResolvedValue({
		url: 'https://x/issues/1',
		number: 1,
		action: 'created',
	});
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

	it('passes the same teamMap instance to org and team audits', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(
			cfg({ teamMap: { infra: { owner: 'acme', repo: 'infra-board' } } }),
		);
		const sharedMap = new Map<string, Set<string>>([['alice', new Set(['infra'])]]);
		vi.mocked(teamsModule.buildTeamMap).mockResolvedValue(sharedMap);

		await run();

		expect(vi.mocked(orgModule.auditOrg).mock.calls[0][2]).toBe(sharedMap);
		expect(vi.mocked(teamModule.auditTeams).mock.calls[0][2]).toBe(sharedMap);
	});

	it('runs per-team audits when team-map is non-empty', async () => {
		vi.mocked(inputsModule.parseInputs).mockReturnValue(
			cfg({ teamMap: { infra: { owner: 'acme', repo: 'infra-board' } } }),
		);
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
