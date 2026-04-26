import { describe, it, expect, vi } from 'vitest';
import { buildTeamMap, listTeamMembers, listTeamRepos } from './teams.js';
import type { Octokit } from '../types.js';

function makeOctokit(graphql: (q: string, vars: unknown) => Promise<unknown>): Octokit {
	return { graphql: vi.fn(graphql) } as unknown as Octokit;
}

describe('buildTeamMap', () => {
	it('returns map of login -> set of team slugs', async () => {
		const octokit = makeOctokit(async () => ({
			organization: {
				teams: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [
						{
							slug: 'infra',
							members: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [{ login: 'alice' }, { login: 'bob' }],
							},
						},
						{
							slug: 'data',
							members: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [{ login: 'bob' }, { login: 'carol' }],
							},
						},
					],
				},
			},
		}));
		const map = await buildTeamMap(octokit, 'acme');
		expect(map.get('alice')).toEqual(new Set(['infra']));
		expect(map.get('bob')).toEqual(new Set(['infra', 'data']));
		expect(map.get('carol')).toEqual(new Set(['data']));
	});

	it('paginates outer teams cursor', async () => {
		let call = 0;
		const octokit = makeOctokit(async () => {
			call += 1;
			if (call === 1) {
				return {
					organization: {
						teams: {
							pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
							nodes: [
								{
									slug: 'infra',
									members: {
										pageInfo: { hasNextPage: false, endCursor: null },
										nodes: [{ login: 'alice' }],
									},
								},
							],
						},
					},
				};
			}
			return {
				organization: {
					teams: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{
								slug: 'data',
								members: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [{ login: 'bob' }],
								},
							},
						],
					},
				},
			};
		});
		const map = await buildTeamMap(octokit, 'acme');
		expect(map.get('alice')).toEqual(new Set(['infra']));
		expect(map.get('bob')).toEqual(new Set(['data']));
	});

	it('paginates inner team-members cursor', async () => {
		let call = 0;
		const octokit = makeOctokit(async () => {
			call += 1;
			if (call === 1) {
				return {
					organization: {
						teams: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									slug: 'infra',
									members: {
										pageInfo: { hasNextPage: true, endCursor: 'M1' },
										nodes: [{ login: 'alice' }],
									},
								},
							],
						},
					},
				};
			}
			return {
				organization: {
					team: {
						members: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [{ login: 'bob' }],
						},
					},
				},
			};
		});
		const map = await buildTeamMap(octokit, 'acme');
		expect(map.get('alice')).toEqual(new Set(['infra']));
		expect(map.get('bob')).toEqual(new Set(['infra']));
	});

	it('handles team with zero members', async () => {
		const octokit = makeOctokit(async () => ({
			organization: {
				teams: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [
						{
							slug: 'empty',
							members: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [],
							},
						},
					],
				},
			},
		}));
		const map = await buildTeamMap(octokit, 'acme');
		expect(map.size).toBe(0);
	});

	it('throws when org is unknown', async () => {
		const octokit = makeOctokit(async () => ({ organization: null }));
		await expect(buildTeamMap(octokit, 'ghost')).rejects.toThrow(/ghost/);
	});
});

function makeRestOctokit(paginate: (route: string, params: unknown) => Promise<unknown>): Octokit {
	return { paginate: vi.fn(paginate) } as unknown as Octokit;
}

describe('listTeamMembers', () => {
	it('returns the logins from /orgs/{org}/teams/{slug}/members', async () => {
		const octokit = makeRestOctokit(async (route, params) => {
			expect(route).toBe('GET /orgs/{org}/teams/{team_slug}/members');
			expect(params).toMatchObject({ org: 'acme', team_slug: 'infra' });
			return [{ login: 'alice' }, { login: 'bob' }];
		});
		expect(await listTeamMembers(octokit, 'acme', 'infra')).toEqual(['alice', 'bob']);
	});
});

describe('listTeamRepos', () => {
	it('returns owner/repo/archived from /orgs/{org}/teams/{slug}/repos', async () => {
		const octokit = makeRestOctokit(async (route, params) => {
			expect(route).toBe('GET /orgs/{org}/teams/{team_slug}/repos');
			expect(params).toMatchObject({ org: 'acme', team_slug: 'infra' });
			return [
				{ owner: { login: 'acme' }, name: 'infra1', archived: false },
				{ owner: { login: 'acme' }, name: 'old-fork', archived: true },
				{ owner: { login: 'acme' }, name: 'no-archive-flag' },
			];
		});
		expect(await listTeamRepos(octokit, 'acme', 'infra')).toEqual([
			{ owner: 'acme', repo: 'infra1', archived: false },
			{ owner: 'acme', repo: 'old-fork', archived: true },
			{ owner: 'acme', repo: 'no-archive-flag', archived: false },
		]);
	});
});
