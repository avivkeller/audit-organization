import type { ActivitySignal, Octokit } from '../types.js';

interface ContributionsByRepoEntry {
	repository: { nameWithOwner: string };
	contributions: { totalCount: number };
}

interface ContributionsCollection {
	hasAnyContributions: boolean;
	totalCommitContributions: number;
	totalIssueContributions: number;
	totalPullRequestContributions: number;
	totalPullRequestReviewContributions: number;
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

const ORG_ID_QUERY = /* GraphQL */ `
	query ($org: String!) {
		organization(login: $org) {
			id
		}
	}
`;

// `contributionsCollection(organizationID:)` is the workhorse: one call per
// member returns commit / issue / PR / review counts scoped to the org. The
// per-repository breakdowns are only needed when ignoreRepositories is non-
// empty so we can subtract them from the total.
const CONTRIBUTIONS_QUERY = /* GraphQL */ `
	query ($login: String!, $orgId: ID!, $from: DateTime!, $to: DateTime!) {
		user(login: $login) {
			contributionsCollection(organizationID: $orgId, from: $from, to: $to) {
				hasAnyContributions
				totalCommitContributions
				totalIssueContributions
				totalPullRequestContributions
				totalPullRequestReviewContributions
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
	const res = await octokit.graphql<UserContributionsResponse>(CONTRIBUTIONS_QUERY, {
		login,
		orgId,
		from,
		to,
	});
	return res.user?.contributionsCollection ?? null;
}

export function activityFromContributions(
	contributions: ContributionsCollection | null,
	ignoreRepos: ReadonlySet<string>,
): ActivitySignal {
	if (!contributions) return { hasActivity: false, lastSeen: null };

	// Fast path: when nothing is filtered out, the API's own boolean is
	// authoritative and skips the per-repo scan.
	if (ignoreRepos.size === 0) {
		return { hasActivity: contributions.hasAnyContributions, lastSeen: null };
	}

	// Filtered path: a contributor whose only activity was in an ignored repo
	// (e.g. a deprecated fork) should read as inactive.
	const buckets: ContributionsByRepoEntry[][] = [
		contributions.commitContributionsByRepository,
		contributions.issueContributionsByRepository,
		contributions.pullRequestContributionsByRepository,
		contributions.pullRequestReviewContributionsByRepository,
	];

	for (const bucket of buckets) {
		for (const entry of bucket) {
			if (!ignoreRepos.has(entry.repository.nameWithOwner) && entry.contributions.totalCount > 0) {
				return { hasActivity: true, lastSeen: null };
			}
		}
	}
	return { hasActivity: false, lastSeen: null };
}
