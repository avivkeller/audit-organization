import { describe, it, expect, vi } from 'vitest';
import { probeOrgComments } from './activity-comments.js';
import type { Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

function makeOctokit(request: (route: string, params: unknown) => Promise<unknown>): Octokit {
	return { request: vi.fn(request) } as unknown as Octokit;
}

describe('probeOrgComments', () => {
	it('returns hasActivity=true when search has any hits', async () => {
		const octokit = makeOctokit(async () => ({ data: { total_count: 3 } }));
		const sig = await probeOrgComments(octokit, 'octocat', 'acme', '2026-01-26T00:00:00Z');
		expect(sig.hasActivity).toBe(true);
	});

	it('returns hasActivity=false on zero hits', async () => {
		const octokit = makeOctokit(async () => ({ data: { total_count: 0 } }));
		const sig = await probeOrgComments(octokit, 'ghost', 'acme', '2026-01-26T00:00:00Z');
		expect(sig.hasActivity).toBe(false);
	});

	it('builds search query with commenter, org, and date', async () => {
		const request = vi.fn(async () => ({ data: { total_count: 0 } }));
		await probeOrgComments(makeOctokit(request), 'octocat', 'acme', '2026-01-26T12:34:56Z');
		expect(request).toHaveBeenCalledWith(
			'GET /search/issues',
			expect.objectContaining({ q: 'commenter:octocat org:acme updated:>=2026-01-26' }),
		);
	});

	it('rate-limit errors propagate', async () => {
		const octokit = makeOctokit(async () => {
			const e = new Error('API rate limit exceeded') as Error & { status?: number };
			e.status = 403;
			throw e;
		});
		await expect(probeOrgComments(octokit, 'octocat', 'acme', '2026-01-26Z')).rejects.toThrow(
			/rate limit/,
		);
	});
});
