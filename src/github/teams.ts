import type { Octokit } from '../types.js';

interface PageInfo {
	hasNextPage: boolean;
	endCursor: string | null;
}

interface TeamsPageResponse {
	organization: {
		teams: {
			pageInfo: PageInfo;
			nodes: Array<{
				slug: string;
				members: { pageInfo: PageInfo; nodes: Array<{ login: string }> };
			}>;
		};
	} | null;
}

interface TeamMembersPageResponse {
	organization: {
		team: {
			members: { pageInfo: PageInfo; nodes: Array<{ login: string }> };
		} | null;
	} | null;
}

// Single GraphQL query: list all teams and the first 100 members of each, with
// outer (teams) and inner (members) pagination cursors. Fetching teams + their
// members in one round-trip is dramatically cheaper than N REST calls.
const TEAMS_QUERY = /* GraphQL */ `
	query ($org: String!, $cursor: String) {
		organization(login: $org) {
			teams(first: 50, after: $cursor) {
				pageInfo {
					hasNextPage
					endCursor
				}
				nodes {
					slug
					members(first: 100) {
						pageInfo {
							hasNextPage
							endCursor
						}
						nodes {
							login
						}
					}
				}
			}
		}
	}
`;

// Used to drain a single team's member list when it exceeds 100.
const TEAM_MEMBERS_QUERY = /* GraphQL */ `
	query ($org: String!, $slug: String!, $cursor: String) {
		organization(login: $org) {
			team(slug: $slug) {
				members(first: 100, after: $cursor) {
					pageInfo {
						hasNextPage
						endCursor
					}
					nodes {
						login
					}
				}
			}
		}
	}
`;

// Inverted index: login -> set of team slugs. The org audit's "no team" check
// is then a single map lookup per member instead of an N x M scan.
export async function buildTeamMap(
	octokit: Octokit,
	org: string,
): Promise<Map<string, Set<string>>> {
	const map = new Map<string, Set<string>>();
	let cursor: string | null = null;

	while (true) {
		const res: TeamsPageResponse = await octokit.graphql<TeamsPageResponse>(TEAMS_QUERY, {
			org,
			cursor,
		});
		if (!res.organization) {
			throw new Error(`organization "${org}" not found or token lacks visibility`);
		}
		for (const team of res.organization.teams.nodes) {
			const logins = team.members.nodes.map((m) => m.login);
			if (team.members.pageInfo.hasNextPage) {
				let inner: string | null = team.members.pageInfo.endCursor;
				while (inner) {
					const more: TeamMembersPageResponse = await octokit.graphql<TeamMembersPageResponse>(
						TEAM_MEMBERS_QUERY,
						{ org, slug: team.slug, cursor: inner },
					);
					const teamData = more.organization?.team;
					if (!teamData) break;
					for (const node of teamData.members.nodes) logins.push(node.login);
					inner = teamData.members.pageInfo.hasNextPage
						? teamData.members.pageInfo.endCursor
						: null;
				}
			}
			for (const login of logins) {
				let teamsForUser = map.get(login);
				if (!teamsForUser) {
					teamsForUser = new Set();
					map.set(login, teamsForUser);
				}
				teamsForUser.add(team.slug);
			}
		}
		if (!res.organization.teams.pageInfo.hasNextPage) break;
		cursor = res.organization.teams.pageInfo.endCursor;
	}

	return map;
}

export async function listTeamMembers(
	octokit: Octokit,
	org: string,
	slug: string,
): Promise<string[]> {
	const data = await octokit.paginate('GET /orgs/{org}/teams/{team_slug}/members', {
		org,
		team_slug: slug,
		per_page: 100,
	});
	return (data as Array<{ login: string }>).map((m) => m.login);
}

export interface TeamRepo {
	owner: string;
	repo: string;
	archived: boolean;
}

export async function listTeamRepos(
	octokit: Octokit,
	org: string,
	slug: string,
): Promise<TeamRepo[]> {
	const data = await octokit.paginate('GET /orgs/{org}/teams/{team_slug}/repos', {
		org,
		team_slug: slug,
		per_page: 100,
	});
	return (data as Array<{ owner: { login: string }; name: string; archived?: boolean }>).map(
		(r) => ({ owner: r.owner.login, repo: r.name, archived: !!r.archived }),
	);
}
