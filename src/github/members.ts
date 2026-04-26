import type { Octokit } from '../types.js';

// Outside collaborators are not org members in the strict sense, but the audit
// can opt in to include them via include-outside-collaborators.
export async function listOrgMembers(
	octokit: Octokit,
	org: string,
	includeOutsideCollaborators: boolean,
): Promise<string[]> {
	const members = await octokit.paginate('GET /orgs/{org}/members', {
		org,
		per_page: 100,
	});
	const logins = new Set<string>((members as Array<{ login: string }>).map((m) => m.login));

	if (includeOutsideCollaborators) {
		const collabs = await octokit.paginate('GET /orgs/{org}/outside_collaborators', {
			org,
			per_page: 100,
		});
		for (const c of collabs as Array<{ login: string }>) logins.add(c.login);
	}
	return [...logins];
}
