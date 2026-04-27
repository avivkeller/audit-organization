import type { ActivitySignal, InteractionType, Octokit } from '../types.js';

interface ContributionsByRepoEntry {
	repository: { nameWithOwner: string };
	contributions: { totalCount: number };
}

interface ContributionDay {
	date: string;
	contributionCount: number;
}

interface ContributionWeek {
	contributionDays: ContributionDay[];
}

interface ContributionCalendar {
	weeks: ContributionWeek[];
}

export interface ContributionsCollection {
	hasAnyContributions: boolean;
	totalCommitContributions: number;
	totalIssueContributions: number;
	totalPullRequestContributions: number;
	totalPullRequestReviewContributions: number;
	contributionCalendar: ContributionCalendar;
	commitContributionsByRepository: ContributionsByRepoEntry[];
	issueContributionsByRepository: ContributionsByRepoEntry[];
	pullRequestContributionsByRepository: ContributionsByRepoEntry[];
	pullRequestReviewContributionsByRepository: ContributionsByRepoEntry[];
}

interface UserContributionsResponse {
	user: { contributionsCollection: ContributionsCollection } | null;
}

interface OrgIdResponse {
	organization: { id: string } | null;
}

interface IssueCommentNode {
	updatedAt: string;
	repository: { nameWithOwner: string; owner: { login: string } };
	pullRequest: { id: string } | null;
}

interface UserIssueCommentsResponse {
	user: {
		issueComments: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: Array<IssueCommentNode | null>;
		};
	} | null;
}

export interface UserComment {
	readonly repo: string;
	readonly type: 'issue-comment' | 'pr-comment';
	readonly updatedAt: string;
}

const ORG_ID_QUERY = /* GraphQL */ `
	query ($org: String!) {
		organization(login: $org) {
			id
		}
	}
`;

// Single GraphQL roundtrip per member. `contributionsCollection(organizationID:)`
// is org-scoped and time-bounded by `from`/`to`. It surfaces commits, issues,
// PRs, and PR reviews.
const ORG_ACTIVITY_QUERY = /* GraphQL */ `
	query ($login: String!, $orgId: ID!, $from: DateTime!, $to: DateTime!) {
		user(login: $login) {
			contributionsCollection(organizationID: $orgId, from: $from, to: $to) {
				hasAnyContributions
				totalCommitContributions
				totalIssueContributions
				totalPullRequestContributions
				totalPullRequestReviewContributions
				contributionCalendar {
					weeks {
						contributionDays {
							date
							contributionCount
						}
					}
				}
				commitContributionsByRepository(maxRepositories: 100) {
					repository {
						nameWithOwner
					}
					contributions {
						totalCount
					}
				}
				issueContributionsByRepository(maxRepositories: 100) {
					repository {
						nameWithOwner
					}
					contributions {
						totalCount
					}
				}
				pullRequestContributionsByRepository(maxRepositories: 100) {
					repository {
						nameWithOwner
					}
					contributions {
						totalCount
					}
				}
				pullRequestReviewContributionsByRepository(maxRepositories: 100) {
					repository {
						nameWithOwner
					}
					contributions {
						totalCount
					}
				}
			}
		}
	}
`;

// Comments are NOT part of `contributionsCollection` (schema fact) and have no
// org-scoped or date-bounded variant on `User`. We fetch the user's
// `issueComments` ordered by UPDATED_AT DESC and walk pages until either the
// list is exhausted or we cross below `since`.
const USER_ISSUE_COMMENTS_QUERY = /* GraphQL */ `
	query ($login: String!, $cursor: String) {
		user(login: $login) {
			issueComments(first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
				pageInfo {
					hasNextPage
					endCursor
				}
				nodes {
					updatedAt
					repository {
						nameWithOwner
						owner {
							login
						}
					}
					pullRequest {
						id
					}
				}
			}
		}
	}
`;

// `organizationID` on contributionsCollection requires the GraphQL node ID, not
// the login. Cache the lookup once per run.
export async function fetchOrgId(octokit: Octokit, org: string): Promise<string> {
	const res = await octokit.graphql<OrgIdResponse>(ORG_ID_QUERY, { org });
	if (!res.organization) {
		throw new Error(`organization "${org}" not found or token lacks visibility`);
	}
	return res.organization.id;
}

export async function fetchOrgActivity(
	octokit: Octokit,
	login: string,
	orgId: string,
	from: string,
	to: string,
): Promise<ContributionsCollection | null> {
	const res = await octokit.graphql<UserContributionsResponse>(ORG_ACTIVITY_QUERY, {
		login,
		orgId,
		from,
		to,
	});
	return res.user?.contributionsCollection ?? null;
}

// Paginated. Returns the user's issue/PR conversation comments in the given
// org that are within the window (`updatedAt >= since`). DESC ordering lets us
// stop as soon as we cross below `since`. Comments outside `org` are skipped
// (filtered client-side; the API has no org filter for this connection) but
// don't terminate the walk.
export async function fetchUserCommentsInOrg(
	octokit: Octokit,
	login: string,
	org: string,
	since: string,
): Promise<UserComment[]> {
	const out: UserComment[] = [];
	let cursor: string | null = null;
	while (true) {
		const res: UserIssueCommentsResponse = await octokit.graphql<UserIssueCommentsResponse>(
			USER_ISSUE_COMMENTS_QUERY,
			{ login, cursor },
		);
		const conn = res.user?.issueComments;
		if (!conn) return out;
		for (const node of conn.nodes) {
			if (!node) continue;
			// DESC ordering by updatedAt: once we see an older-than-window comment,
			// the rest of this page (and all later pages) are also out of window.
			if (node.updatedAt < since) return out;
			if (node.repository.owner.login !== org) continue;
			out.push({
				repo: node.repository.nameWithOwner,
				type: node.pullRequest ? 'pr-comment' : 'issue-comment',
				updatedAt: node.updatedAt,
			});
		}
		if (!conn.pageInfo.hasNextPage) return out;
		cursor = conn.pageInfo.endCursor;
	}
}

// Calendar dates are `YYYY-MM-DD` (no time component); we surface them as ISO
// strings at end-of-day UTC so they compare correctly against `since`/`now`.
function lastActiveDateFromCalendar(calendar: ContributionCalendar | undefined): string | null {
	if (!calendar) return null;
	let latest: string | null = null;
	for (const week of calendar.weeks) {
		for (const day of week.contributionDays) {
			if (day.contributionCount > 0 && (!latest || day.date > latest)) {
				latest = day.date;
			}
		}
	}
	return latest ? `${latest}T23:59:59Z` : null;
}

// `(repo) => true` if the repo should count toward activity. Org audits pass
// `(r) => !ignoreRepos.has(r)` (deny-list); team audits pass
// `(r) => teamRepos.has(r)` (allow-list).
export type RepoFilter = (repo: string) => boolean;

// Walks `contributions` and yields per-repo entries restricted to the buckets
// implied by `types`. The two comment types are no-ops here because the
// GraphQL schema does not surface comments as contributions.
function* contributionEntries(
	contributions: ContributionsCollection,
	types: ReadonlySet<InteractionType>,
): Iterable<ContributionsByRepoEntry> {
	if (types.has('commit')) yield* contributions.commitContributionsByRepository;
	if (types.has('issue')) yield* contributions.issueContributionsByRepository;
	if (types.has('pr')) yield* contributions.pullRequestContributionsByRepository;
	if (types.has('pr-review')) yield* contributions.pullRequestReviewContributionsByRepository;
}

// Repo-set helper: which repos in this contributions snapshot saw activity
// within the window, restricted to the requested interaction types and with
// the supplied filter applied. Effectively the time-bounded answer to "what
// repos did this user contribute to in the past N days?".
export function repositoriesContributedTo(
	contributions: ContributionsCollection | null,
	types: ReadonlySet<InteractionType>,
	repoFilter: RepoFilter,
): Set<string> {
	const out = new Set<string>();
	if (!contributions) return out;
	for (const entry of contributionEntries(contributions, types)) {
		const name = entry.repository.nameWithOwner;
		if (entry.contributions.totalCount > 0 && repoFilter(name)) out.add(name);
	}
	return out;
}

// Did the user contribute to any repo accepted by `repoFilter` in the window,
// for any requested interaction type? `lastSeen` is read from the calendar and
// is reported regardless of `repoFilter` - it's an upper bound on observed
// activity, informative even when the verdict is "inactive".
export function contributionActivity(
	contributions: ContributionsCollection | null,
	types: ReadonlySet<InteractionType>,
	repoFilter: RepoFilter,
): ActivitySignal {
	if (!contributions) return { hasActivity: false, lastSeen: null };
	const lastSeen = lastActiveDateFromCalendar(contributions.contributionCalendar);
	for (const entry of contributionEntries(contributions, types)) {
		if (repoFilter(entry.repository.nameWithOwner) && entry.contributions.totalCount > 0) {
			return { hasActivity: true, lastSeen };
		}
	}
	return { hasActivity: false, lastSeen };
}

// Comment-only activity check (used as a fallback after `contributionsCollection`
// returns nothing, since comments are not part of that collection). `lastSeen`
// is the most recent matching comment's `updatedAt`.
export function commentActivity(
	comments: readonly UserComment[],
	types: ReadonlySet<InteractionType>,
	repoFilter: RepoFilter,
): ActivitySignal {
	let lastSeen: string | null = null;
	let hasActivity = false;
	for (const c of comments) {
		if (!types.has(c.type)) continue;
		if (!repoFilter(c.repo)) continue;
		hasActivity = true;
		if (!lastSeen || c.updatedAt > lastSeen) lastSeen = c.updatedAt;
	}
	return { hasActivity, lastSeen };
}
