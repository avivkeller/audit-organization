import type { getOctokit } from '@actions/github';

export type Octokit = ReturnType<typeof getOctokit>;

export type InteractionType =
	| 'commit'
	| 'pr'
	| 'pr-review'
	| 'pr-comment'
	| 'issue'
	| 'issue-comment';

export const ALL_INTERACTION_TYPES: readonly InteractionType[] = [
	'commit',
	'pr',
	'pr-review',
	'pr-comment',
	'issue',
	'issue-comment',
] as const;

export interface AuditConfig {
	readonly org: string;
	readonly token: string;
	readonly reportRepo: { owner: string; repo: string };
	readonly inactivityDays: number;
	readonly since: string;
	readonly now: string;
	readonly teamMap: Readonly<Record<string, { owner: string; repo: string }>>;
	readonly dryRun: boolean;
	readonly ignoreRepositories: ReadonlySet<string>;
	readonly ignoreMembers: ReadonlySet<string>;
	readonly ignoreTeams: ReadonlySet<string>;
	readonly includeOutsideCollaborators: boolean;
	readonly includeBots: boolean;
	readonly interactionTypes: ReadonlySet<InteractionType>;
	readonly concurrency: number;
}

export type InactivityReason = 'no-activity' | 'no-team' | 'no-activity, no-team';

export interface InactiveMember {
	readonly login: string;
	readonly reason: InactivityReason;
	readonly teams: readonly string[];
	readonly lastSeen: string | null;
}

export interface AuditError {
	readonly login: string;
	readonly cause: string;
}

export interface OrgAuditResult {
	readonly org: string;
	readonly totalAudited: number;
	readonly inactive: readonly InactiveMember[];
	readonly errors: readonly AuditError[];
	readonly noTeamCount: number;
	readonly noActivityCount: number;
	readonly bothCount: number;
	readonly runAt: string;
}

export interface TeamAuditResult {
	readonly slug: string;
	readonly reportRepo: { owner: string; repo: string };
	readonly totalAudited: number;
	readonly inactive: readonly InactiveMember[];
	readonly auditedRepos: readonly string[];
	readonly errors: readonly AuditError[];
	readonly runAt: string;
}

export interface ActivitySignal {
	readonly hasActivity: boolean;
	readonly lastSeen: string | null;
}
