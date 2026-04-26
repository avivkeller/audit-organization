import { describe, it, expect, vi } from 'vitest';
import { probeRepo } from './activity-rest.js';
import type { InteractionType, Octokit } from '../types.js';

vi.mock('@actions/core', () => ({
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

interface RouteResponse {
	status?: number;
	data?: unknown;
}

function makeOctokit(routes: Record<string, RouteResponse | (() => RouteResponse)>): Octokit {
	const request = vi.fn(async (route: string) => {
		const handler = routes[route];
		if (!handler) {
			const err = new Error(`unhandled route: ${route}`) as Error & { status?: number };
			err.status = 404;
			throw err;
		}
		const value = typeof handler === 'function' ? handler() : handler;
		if ((value as { _throw?: { status: number; message: string } })._throw) {
			const e = (value as { _throw: { status: number; message: string } })._throw;
			const err = new Error(e.message) as Error & { status?: number };
			err.status = e.status;
			throw err;
		}
		return { status: value.status ?? 200, data: value.data ?? [] };
	});
	return { request } as unknown as Octokit;
}

const types = (...t: InteractionType[]): Set<InteractionType> => new Set(t);

describe('probeRepo', () => {
	it('returns hasActivity=true on first commit hit, short-circuiting later checks', async () => {
		const issuesHandler = vi.fn(() => ({ data: [] }));
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/commits': {
				data: [{ commit: { author: { date: '2026-04-01T00:00:00Z' } } }],
			},
			'GET /repos/{owner}/{repo}/issues': issuesHandler,
		});
		const sig = await probeRepo(
			octokit,
			'acme',
			'main',
			'octocat',
			'2026-01-01T00:00:00Z',
			types('commit', 'issue'),
		);
		expect(sig.hasActivity).toBe(true);
		expect(sig.lastSeen).toBe('2026-04-01T00:00:00Z');
		expect(issuesHandler).not.toHaveBeenCalled();
	});

	it('returns hasActivity=false when no probe finds activity', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/commits': { data: [] },
			'GET /repos/{owner}/{repo}/issues': { data: [] },
		});
		const sig = await probeRepo(
			octokit,
			'acme',
			'main',
			'octocat',
			'2026-01-01Z',
			types('commit', 'issue'),
		);
		expect(sig.hasActivity).toBe(false);
	});

	it('treats 404 as no-activity, not fatal', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/commits': {
				_throw: { status: 404, message: 'not found' },
			} as RouteResponse,
		});
		const sig = await probeRepo(octokit, 'acme', 'gone', 'octocat', '2026-01-01Z', types('commit'));
		expect(sig.hasActivity).toBe(false);
	});

	it('treats 403 as no-activity', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/commits': {
				_throw: { status: 403, message: 'forbidden' },
			} as RouteResponse,
		});
		const sig = await probeRepo(
			octokit,
			'acme',
			'private',
			'octocat',
			'2026-01-01Z',
			types('commit'),
		);
		expect(sig.hasActivity).toBe(false);
	});

	it('rethrows unexpected errors (e.g. 500)', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/commits': {
				_throw: { status: 500, message: 'server error' },
			} as RouteResponse,
		});
		await expect(
			probeRepo(octokit, 'acme', 'main', 'octocat', '2026-01-01Z', types('commit')),
		).rejects.toThrow(/server error/);
	});

	it('discriminates issue vs pr in /issues response', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/issues': {
				data: [
					{ pull_request: {}, updated_at: '2026-04-10T00:00:00Z' },
					{ updated_at: '2026-04-09T00:00:00Z' },
				],
			},
		});
		const onlyIssue = await probeRepo(
			octokit,
			'acme',
			'main',
			'octocat',
			'2026-01-01Z',
			types('issue'),
		);
		expect(onlyIssue.hasActivity).toBe(true);
		expect(onlyIssue.lastSeen).toBe('2026-04-09T00:00:00Z');

		const onlyPr = await probeRepo(octokit, 'acme', 'main', 'octocat', '2026-01-01Z', types('pr'));
		expect(onlyPr.hasActivity).toBe(true);
		expect(onlyPr.lastSeen).toBe('2026-04-10T00:00:00Z');
	});

	it('filters issue/PR comments by user.login', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/issues/comments': {
				data: [
					{ user: { login: 'someone-else' }, updated_at: '2026-04-10T00:00:00Z' },
					{ user: { login: 'octocat' }, updated_at: '2026-04-11T00:00:00Z' },
				],
			},
		});
		const sig = await probeRepo(
			octokit,
			'acme',
			'main',
			'octocat',
			'2026-01-01Z',
			types('issue-comment'),
		);
		expect(sig.hasActivity).toBe(true);
		expect(sig.lastSeen).toBe('2026-04-11T00:00:00Z');
	});

	it('searches PR reviews and matches by user.login', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/pulls': {
				data: [{ number: 42, updated_at: '2026-04-10T00:00:00Z' }],
			},
			'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': {
				data: [{ user: { login: 'octocat' }, submitted_at: '2026-04-10T01:00:00Z' }],
			},
		});
		const sig = await probeRepo(
			octokit,
			'acme',
			'main',
			'octocat',
			'2026-01-01Z',
			types('pr-review'),
		);
		expect(sig.hasActivity).toBe(true);
		expect(sig.lastSeen).toBe('2026-04-10T01:00:00Z');
	});

	it('skips PRs not updated since the cutoff', async () => {
		const reviewsHandler = vi.fn(() => ({ data: [] }));
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/pulls': {
				data: [{ number: 42, updated_at: '2025-01-01T00:00:00Z' }],
			},
			'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': reviewsHandler,
		});
		const sig = await probeRepo(
			octokit,
			'acme',
			'main',
			'octocat',
			'2026-01-01Z',
			types('pr-review'),
		);
		expect(sig.hasActivity).toBe(false);
		expect(reviewsHandler).not.toHaveBeenCalled();
	});

	it('records the latest no-activity lastSeen across multiple probes', async () => {
		const octokit = makeOctokit({
			'GET /repos/{owner}/{repo}/commits': { data: [] },
			'GET /repos/{owner}/{repo}/issues/comments': {
				data: [{ user: { login: 'somebody-else' }, updated_at: '2026-03-01T00:00:00Z' }],
			},
		});
		const sig = await probeRepo(
			octokit,
			'acme',
			'main',
			'octocat',
			'2026-01-01Z',
			types('commit', 'issue-comment'),
		);
		expect(sig.hasActivity).toBe(false);
	});
});
