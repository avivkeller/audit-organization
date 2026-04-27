import { wantsCommentSignal } from '../filter.js';
import { maxIso } from '../github/cache.js';
import type { ActivitySignal, AuditConfig, Octokit } from '../types.js';
import {
	commentActivity,
	contributionActivity,
	fetchOrgActivity,
	fetchOrgId,
	fetchUserCommentsInOrg,
	type ContributionsCollection,
	type RepoFilter,
	type UserComment,
} from './graphql.js';

// Static, run-scoped audit context: octokit + config + a memoized org-id
// lookup. `getOrgId` is lazy so a run where every member is cache-resolved
// pays nothing for the lookup.
export interface AuditContext {
	readonly octokit: Octokit;
	readonly cfg: AuditConfig;
	getOrgId(): Promise<string>;
}

export function createContext(octokit: Octokit, cfg: AuditConfig): AuditContext {
	let orgIdPromise: Promise<string> | null = null;
	return {
		octokit,
		cfg,
		getOrgId() {
			if (!orgIdPromise) orgIdPromise = fetchOrgId(octokit, cfg.org);
			return orgIdPromise;
		},
	};
}

// Per-run dedup cache for the two per-user GraphQL probes. The org audit and
// every team audit consult the same instance, so a member who appears in
// `auditOrg` and N teams costs at most one `fetchOrgActivity` call (and at
// most one `fetchUserCommentsInOrg` call, fetched lazily only when a fallback
// is actually triggered). In-flight promises are shared, so concurrent
// callers also collapse to a single network call.
export class UserProbeCache {
	private readonly contribs = new Map<string, Promise<ContributionsCollection | null>>();
	private readonly commentsByLogin = new Map<string, Promise<readonly UserComment[]>>();

	constructor(public readonly ctx: AuditContext) {}

	getContributions(login: string): Promise<ContributionsCollection | null> {
		let p = this.contribs.get(login);
		if (!p) {
			const { ctx } = this;
			p = (async () => {
				const orgId = await ctx.getOrgId();
				return fetchOrgActivity(ctx.octokit, login, orgId, ctx.cfg.since, ctx.cfg.now);
			})();
			this.contribs.set(login, p);
		}
		return p;
	}

	getComments(login: string): Promise<readonly UserComment[]> {
		let p = this.commentsByLogin.get(login);
		if (!p) {
			const { ctx } = this;
			p = fetchUserCommentsInOrg(ctx.octokit, login, ctx.cfg.org, ctx.cfg.since);
			this.commentsByLogin.set(login, p);
		}
		return p;
	}
}

// Single-user activity probe shared by org + team audits. Time-bounded
// contributionsCollection check first; if that comes up empty AND the user
// asked for a comment type, fall back to walking issueComments. Both fetches
// route through `cache`, so repeat calls for the same login (across audits or
// concurrent within one) collapse to one network call each.
export async function probeUserActivity(
	cache: UserProbeCache,
	login: string,
	repoFilter: RepoFilter,
): Promise<ActivitySignal> {
	const types = cache.ctx.cfg.interactionTypes;
	const contributions = await cache.getContributions(login);
	const sig = contributionActivity(contributions, types, repoFilter);
	if (sig.hasActivity || !wantsCommentSignal(types)) return sig;

	const comments = await cache.getComments(login);
	const commentSig = commentActivity(comments, types, repoFilter);
	return {
		hasActivity: commentSig.hasActivity,
		lastSeen: maxIso(sig.lastSeen, commentSig.lastSeen),
	};
}
