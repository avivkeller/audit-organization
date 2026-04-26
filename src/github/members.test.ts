import { describe, it, expect, vi } from 'vitest';
import { listOrgMembers } from './members.js';
import type { Octokit } from '../types.js';

function makeOctokit(paginateImpl: (route: string, params: unknown) => Promise<unknown>): Octokit {
	return { paginate: vi.fn(paginateImpl) } as unknown as Octokit;
}

describe('listOrgMembers', () => {
	it('returns deduped logins of org members', async () => {
		const octokit = makeOctokit(async (route) => {
			if (route === 'GET /orgs/{org}/members') {
				return [{ login: 'alice' }, { login: 'bob' }, { login: 'alice' }];
			}
			throw new Error(`unexpected route: ${route}`);
		});
		expect(await listOrgMembers(octokit, 'acme', false)).toEqual(['alice', 'bob']);
	});

	it('merges outside collaborators when opted in', async () => {
		const octokit = makeOctokit(async (route) => {
			if (route === 'GET /orgs/{org}/members') return [{ login: 'alice' }];
			if (route === 'GET /orgs/{org}/outside_collaborators') return [{ login: 'eve' }];
			throw new Error(`unexpected route: ${route}`);
		});
		expect((await listOrgMembers(octokit, 'acme', true)).sort()).toEqual(['alice', 'eve']);
	});

	it('does not call outside_collaborators by default', async () => {
		const paginate = vi.fn(async (route: string) => {
			if (route === 'GET /orgs/{org}/members') return [{ login: 'alice' }];
			return [];
		});
		const octokit = { paginate } as unknown as Octokit;
		await listOrgMembers(octokit, 'acme', false);
		expect(paginate).toHaveBeenCalledTimes(1);
	});
});
