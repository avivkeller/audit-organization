import { describe, it, expect, vi } from 'vitest';
import { upsertIssue } from './issue.js';
import type { Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

const makeOctokit = (opts: {
	listResult?: unknown[];
	createResult?: { number: number; html_url: string };
}) => ({
	request: vi.fn(async (route: string) => {
		if (route === 'POST /repos/{owner}/{repo}/issues') {
			return {
				data: opts.createResult ?? { number: 99, html_url: 'https://x/issues/99' },
			};
		}
		return { data: opts.listResult ?? [] };
	}),
});

const baseParams = {
	owner: 'acme',
	repo: 'audits',
	title: 'Organization Inactivity Audit - acme',
	body: 'body',
	labels: ['organization-auditor', 'audit:org'] as const,
	dryRun: false,
	runAt: '2026-04-26T00:00:00Z',
};

describe('upsertIssue', () => {
	it('creates a new issue when none exists', async () => {
		const oct = makeOctokit({ listResult: [] });
		const res = await upsertIssue(oct as unknown as Octokit, baseParams);
		expect(res.action).toBe('created');
		expect(res.url).toBe('https://x/issues/99');
		expect(oct.request).toHaveBeenCalledWith(
			'POST /repos/{owner}/{repo}/issues',
			expect.objectContaining({ title: baseParams.title, body: 'body' }),
		);
	});

	it('updates existing open issue and posts a re-audit comment', async () => {
		const oct = makeOctokit({
			listResult: [
				{ number: 7, html_url: 'https://x/issues/7', updated_at: '2026-04-25T00:00:00Z' },
			],
		});
		const res = await upsertIssue(oct as unknown as Octokit, baseParams);
		expect(res.action).toBe('updated');
		expect(res.number).toBe(7);
		expect(oct.request).toHaveBeenCalledWith(
			'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
			expect.objectContaining({ issue_number: 7, body: 'body' }),
		);
	});

	it('skips API calls in dry-run', async () => {
		const oct = makeOctokit({});
		const res = await upsertIssue(oct as unknown as Octokit, { ...baseParams, dryRun: true });
		expect(res.action).toBe('dry-run');
		expect(res.url).toBe('');
		expect(oct.request).not.toHaveBeenCalled();
	});
});
