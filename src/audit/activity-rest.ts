import * as core from '@actions/core';
import type { ActivitySignal, InteractionType, Octokit } from '../types.js';

interface RequestErrorLike {
	status?: number;
	message?: string;
}

// 404 = repo deleted/transferred since the team-repos snapshot.
// 403 = visibility flipped (private/disabled) — token can't see it now.
// 451 = blocked for legal reasons (DMCA etc).
// All three are "no activity for this user here", not run-fatal.
function isBenign(err: unknown): boolean {
	const e = err as RequestErrorLike;
	return e.status === 404 || e.status === 403 || e.status === 451;
}

async function probeCommits(
	octokit: Octokit,
	owner: string,
	repo: string,
	login: string,
	since: string,
): Promise<ActivitySignal> {
	try {
		// per_page=1 because we only need to know "any" commits, not all of them.
		const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
			owner,
			repo,
			author: login,
			since,
			per_page: 1,
		});
		const arr = res.data as Array<{ commit?: { author?: { date?: string } } }>;
		if (arr.length === 0) return { hasActivity: false, lastSeen: null };
		return { hasActivity: true, lastSeen: arr[0]?.commit?.author?.date ?? null };
	} catch (err) {
		if (isBenign(err)) return { hasActivity: false, lastSeen: null };
		throw err;
	}
}

// /issues returns both issues and PRs in a single response — discriminated by
// the presence of `pull_request`. We filter client-side rather than make two
// calls.
async function probeIssuesOrPulls(
	octokit: Octokit,
	owner: string,
	repo: string,
	login: string,
	since: string,
	want: { issue: boolean; pr: boolean },
): Promise<ActivitySignal> {
	try {
		const res = await octokit.request('GET /repos/{owner}/{repo}/issues', {
			owner,
			repo,
			creator: login,
			since,
			state: 'all',
			per_page: 100,
		});
		const arr = res.data as Array<{ pull_request?: object; updated_at?: string }>;
		for (const item of arr) {
			const isPr = item.pull_request !== undefined;
			if ((isPr && want.pr) || (!isPr && want.issue)) {
				return { hasActivity: true, lastSeen: item.updated_at ?? null };
			}
		}
		return { hasActivity: false, lastSeen: null };
	} catch (err) {
		if (isBenign(err)) return { hasActivity: false, lastSeen: null };
		throw err;
	}
}

// The comments endpoints have no `creator`/`user` filter — we have to fetch a
// page and grep. Acceptable because we sort by `since` and are short-circuiting.
async function probeIssueComments(
	octokit: Octokit,
	owner: string,
	repo: string,
	login: string,
	since: string,
): Promise<ActivitySignal> {
	try {
		const res = await octokit.request('GET /repos/{owner}/{repo}/issues/comments', {
			owner,
			repo,
			since,
			per_page: 100,
		});
		const arr = res.data as Array<{ user?: { login?: string }; updated_at?: string }>;
		for (const c of arr) {
			if (c.user?.login === login) return { hasActivity: true, lastSeen: c.updated_at ?? null };
		}
		return { hasActivity: false, lastSeen: null };
	} catch (err) {
		if (isBenign(err)) return { hasActivity: false, lastSeen: null };
		throw err;
	}
}

async function probePrComments(
	octokit: Octokit,
	owner: string,
	repo: string,
	login: string,
	since: string,
): Promise<ActivitySignal> {
	try {
		const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/comments', {
			owner,
			repo,
			since,
			per_page: 100,
		});
		const arr = res.data as Array<{ user?: { login?: string }; updated_at?: string }>;
		for (const c of arr) {
			if (c.user?.login === login) return { hasActivity: true, lastSeen: c.updated_at ?? null };
		}
		return { hasActivity: false, lastSeen: null };
	} catch (err) {
		if (isBenign(err)) return { hasActivity: false, lastSeen: null };
		throw err;
	}
}

// Reviews are not directly listable by user — we list recent PRs (already
// updated within the window) and inspect each PR's reviews. Worst case is
// 30 PR-fetches per user-per-repo, but most users return early.
async function probePrReviews(
	octokit: Octokit,
	owner: string,
	repo: string,
	login: string,
	since: string,
): Promise<ActivitySignal> {
	try {
		const prs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
			owner,
			repo,
			state: 'all',
			sort: 'updated',
			direction: 'desc',
			per_page: 30,
		});
		const sinceMs = Date.parse(since);
		const recent = (prs.data as Array<{ number: number; updated_at?: string }>).filter(
			(p) => !p.updated_at || Date.parse(p.updated_at) >= sinceMs,
		);
		for (const pr of recent) {
			const reviews = await octokit.request(
				'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
				{
					owner,
					repo,
					pull_number: pr.number,
					per_page: 100,
				},
			);
			const arr = reviews.data as Array<{
				user?: { login?: string };
				submitted_at?: string;
			}>;
			for (const r of arr) {
				if (r.user?.login === login && (!r.submitted_at || Date.parse(r.submitted_at) >= sinceMs)) {
					return { hasActivity: true, lastSeen: r.submitted_at ?? null };
				}
			}
		}
		return { hasActivity: false, lastSeen: null };
	} catch (err) {
		if (isBenign(err)) return { hasActivity: false, lastSeen: null };
		throw err;
	}
}

export async function probeRepo(
	octokit: Octokit,
	owner: string,
	repo: string,
	login: string,
	since: string,
	interactionTypes: ReadonlySet<InteractionType>,
): Promise<ActivitySignal> {
	const checks: Array<() => Promise<ActivitySignal>> = [];

	if (interactionTypes.has('commit')) {
		checks.push(() => probeCommits(octokit, owner, repo, login, since));
	}
	// Issues + PRs share the /issues endpoint; one call serves both flags.
	if (interactionTypes.has('issue') || interactionTypes.has('pr')) {
		checks.push(() =>
			probeIssuesOrPulls(octokit, owner, repo, login, since, {
				issue: interactionTypes.has('issue'),
				pr: interactionTypes.has('pr'),
			}),
		);
	}
	if (interactionTypes.has('issue-comment')) {
		checks.push(() => probeIssueComments(octokit, owner, repo, login, since));
	}
	if (interactionTypes.has('pr-comment')) {
		checks.push(() => probePrComments(octokit, owner, repo, login, since));
	}
	if (interactionTypes.has('pr-review')) {
		checks.push(() => probePrReviews(octokit, owner, repo, login, since));
	}

	let latest: string | null = null;
	for (const check of checks) {
		try {
			const sig = await check();
			// Short-circuit: as soon as any probe finds activity we can stop.
			if (sig.hasActivity) return sig;
			if (sig.lastSeen && (!latest || sig.lastSeen > latest)) latest = sig.lastSeen;
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			core.warning(`probe failed for ${login} on ${owner}/${repo}: ${cause}`);
			throw err;
		}
	}
	return { hasActivity: false, lastSeen: latest };
}
