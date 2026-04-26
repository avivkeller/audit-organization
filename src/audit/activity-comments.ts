import type { ActivitySignal, Octokit } from '../types.js';

// `contributionsCollection` does not include issue/PR comments. The Search API
// is the only practical way to detect "did this user comment anywhere in the
// org in the window" without N x M per-repo polling. It is opt-in because the
// Search API has a 30/min rate limit (much tighter than the 5000/hr core).
export async function probeOrgComments(
	octokit: Octokit,
	login: string,
	org: string,
	since: string,
): Promise<ActivitySignal> {
	// The search query language only accepts date precision (YYYY-MM-DD), not ISO.
	const isoDate = since.slice(0, 10);
	const q = `commenter:${login} org:${org} updated:>=${isoDate}`;
	const res = await octokit.request('GET /search/issues', {
		q,
		per_page: 1,
	});
	const data = res.data as { total_count: number };
	return {
		hasActivity: data.total_count > 0,
		lastSeen: null,
	};
}
