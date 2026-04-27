import { describe, it, expect } from 'vitest';
import { renderOrgReport, renderTeamReport } from './report.js';
import type { AuditConfig, OrgAuditResult, TeamAuditResult } from './types.js';

const cfg: AuditConfig = {
	org: 'acme',
	token: 't',
	reportRepo: { owner: 'acme', repo: 'audits' },
	inactivityDays: 90,
	since: '2026-01-26T00:00:00Z',
	now: '2026-04-26T00:00:00Z',
	dryRun: false,
	ignoreRepositories: new Set(['acme/legacy']),
	ignoreMembers: new Set(['svc-account']),
	ignoreTeams: new Set(['alumni']),
	includeOutsideCollaborators: false,
	includeBots: false,
	interactionTypes: new Set(['commit', 'pr', 'pr-review', 'issue']),
	concurrency: 5,
};

describe('renderOrgReport', () => {
	it('renders header, summary, table, and config block', () => {
		const result: OrgAuditResult = {
			org: 'acme',
			totalAudited: 10,
			inactive: [
				{ login: 'alice', reason: 'no-activity', teams: ['infra'], lastSeen: null },
				{ login: 'bob', reason: 'no-activity, no-team', teams: [], lastSeen: '2025-12-01' },
			],
			errors: [],
			noTeamCount: 1,
			noActivityCount: 2,
			bothCount: 1,
			runAt: '2026-04-26T00:00:00Z',
		};
		const rendered = renderOrgReport(result, cfg);
		expect(rendered.title).toBe('Organization Inactivity Audit - acme');
		expect(rendered.labels).toEqual(['organization-auditor', 'audit:org']);
		expect(rendered.body).toContain('Inactive: 2/10');
		expect(rendered.body).toContain('| @alice | no-activity | - | `infra` |');
		expect(rendered.body).toContain('| @bob | no-activity, no-team | 2025-12-01 | - |');
		expect(rendered.truncated).toBe(false);
	});

	it('handles zero inactive members', () => {
		const result: OrgAuditResult = {
			org: 'acme',
			totalAudited: 5,
			inactive: [],
			errors: [],
			noTeamCount: 0,
			noActivityCount: 0,
			bothCount: 0,
			runAt: '2026-04-26T00:00:00Z',
		};
		const rendered = renderOrgReport(result, cfg);
		expect(rendered.body).toContain('_No inactive members found._');
	});

	it('renders errors section when errors present', () => {
		const result: OrgAuditResult = {
			org: 'acme',
			totalAudited: 1,
			inactive: [],
			errors: [{ login: 'alice', cause: 'rate limited' }],
			noTeamCount: 0,
			noActivityCount: 0,
			bothCount: 0,
			runAt: '2026-04-26T00:00:00Z',
		};
		const rendered = renderOrgReport(result, cfg);
		expect(rendered.body).toContain('## Errors');
		expect(rendered.body).toContain('@alice - `rate limited`');
	});

	it('escapes pipe characters in cells', () => {
		const result: OrgAuditResult = {
			org: 'acme',
			totalAudited: 1,
			inactive: [{ login: 'a|b', reason: 'no-activity', teams: [], lastSeen: 'x|y' }],
			errors: [],
			noTeamCount: 0,
			noActivityCount: 1,
			bothCount: 0,
			runAt: '2026-04-26T00:00:00Z',
		};
		const rendered = renderOrgReport(result, cfg);
		expect(rendered.body).toContain('@a\\|b');
		expect(rendered.body).toContain('x\\|y');
	});

	it('truncates oversized bodies', () => {
		const inactive = Array.from({ length: 5000 }, (_, i) => ({
			login: `user${i}`,
			reason: 'no-activity' as const,
			teams: ['some-team-with-a-longish-name'],
			lastSeen: '2025-01-01T00:00:00Z',
		}));
		const result: OrgAuditResult = {
			org: 'acme',
			totalAudited: 5000,
			inactive,
			errors: [],
			noTeamCount: 0,
			noActivityCount: 5000,
			bothCount: 0,
			runAt: '2026-04-26T00:00:00Z',
		};
		const rendered = renderOrgReport(result, cfg);
		expect(rendered.truncated).toBe(true);
		expect(rendered.body.length).toBeLessThanOrEqual(60_000);
		expect(rendered.body).toContain('truncated');
	});
});

describe('renderTeamReport', () => {
	it('uses team-scoped title and label', () => {
		const result: TeamAuditResult = {
			slug: 'infra',
			reportRepo: { owner: 'acme', repo: 'infra-board' },
			totalAudited: 3,
			inactive: [{ login: 'alice', reason: 'no-activity', teams: ['infra'], lastSeen: null }],
			auditedRepos: ['acme/infra1', 'acme/infra2'],
			errors: [],
			runAt: '2026-04-26T00:00:00Z',
		};
		const rendered = renderTeamReport(result, cfg);
		expect(rendered.title).toBe('Team Inactivity Audit - infra');
		expect(rendered.labels).toEqual(['organization-auditor', 'audit:team:infra']);
		expect(rendered.body).toContain('Repos audited: `acme/infra1`, `acme/infra2`');
	});

	it('flags zero auditable repos in the body', () => {
		const result: TeamAuditResult = {
			slug: 'infra',
			reportRepo: { owner: 'acme', repo: 'infra-board' },
			totalAudited: 1,
			inactive: [{ login: 'alice', reason: 'no-activity', teams: ['infra'], lastSeen: null }],
			auditedRepos: [],
			errors: [],
			runAt: '2026-04-26T00:00:00Z',
		};
		const rendered = renderTeamReport(result, cfg);
		expect(rendered.body).toContain('team has no auditable repos');
	});
});
