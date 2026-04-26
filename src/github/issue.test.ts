import { describe, it, expect, vi } from 'vitest';
import { upsertIssue } from './issue.js';
import type { Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

interface FakeOctokit {
	paginate: ReturnType<typeof vi.fn>;
	request: ReturnType<typeof vi.fn>;
}

function makeOctokit(opts: {
	listResult?: unknown[];
	createResult?: { number: number; html_url: string };
}): FakeOctokit {
	return {
		paginate: vi.fn(async () => opts.listResult ?? []),
		request: vi.fn(async (route: string) => {
			if (route === 'POST /repos/{owner}/{repo}/issues') {
				return {
					data: opts.createResult ?? { number: 99, html_url: 'https://x/issues/99' },
				};
			}
			return { data: {} };
		}),
	};
}

const baseParams = {
	owner: 'acme',
	repo: 'audits',
	title: 'Organization Inactivity Audit — acme',
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
		expect(oct.request).toHaveBeenCalledWith(
			'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
			expect.objectContaining({ issue_number: 7, body: 'Re-audited at 2026-04-26T00:00:00Z' }),
		);
	});

	it('updates the most-recently-updated when multiple matches found', async () => {
		const oct = makeOctokit({
			listResult: [
				{ number: 1, html_url: 'https://x/1', updated_at: '2025-01-01Z' },
				{ number: 2, html_url: 'https://x/2', updated_at: '2026-04-25Z' },
			],
		});
		const res = await upsertIssue(oct as unknown as Octokit, baseParams);
		expect(res.number).toBe(2);
	});

	it('filters out pull_requests from the matches list', async () => {
		const oct = makeOctokit({
			listResult: [
				{ number: 1, html_url: 'https://x/1', updated_at: '2026-04-25Z', pull_request: {} },
			],
			createResult: { number: 50, html_url: 'https://x/50' },
		});
		const res = await upsertIssue(oct as unknown as Octokit, baseParams);
		expect(res.action).toBe('created');
		expect(res.number).toBe(50);
	});

	it('skips API calls in dry-run', async () => {
		const oct = makeOctokit({});
		const res = await upsertIssue(oct as unknown as Octokit, { ...baseParams, dryRun: true });
		expect(res.action).toBe('dry-run');
		expect(res.url).toBe('');
		expect(oct.paginate).not.toHaveBeenCalled();
		expect(oct.request).not.toHaveBeenCalled();
	});
});
