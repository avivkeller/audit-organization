import * as core from '@actions/core';
import type { Octokit } from '../types.js';

export interface UpsertParams {
	readonly owner: string;
	readonly repo: string;
	readonly title: string;
	readonly body: string;
	readonly labels: readonly string[];
	readonly dryRun: boolean;
	readonly runAt: string;
}

export interface UpsertResult {
	readonly url: string;
	readonly number: number | null;
	readonly action: 'created' | 'updated' | 'dry-run';
}

// Idempotency contract: the open issue carrying both labels is THE audit issue
// for this scope. Title is unreliable (humans rename), labels are the contract.
export async function upsertIssue(octokit: Octokit, params: UpsertParams): Promise<UpsertResult> {
	if (params.dryRun) {
		core.info(`[dry-run] would file issue in ${params.owner}/${params.repo}`);
		core.info(`[dry-run] title: ${params.title}`);
		core.info(`[dry-run] labels: ${params.labels.join(', ')}`);
		core.info(`[dry-run] body:\n${params.body}`);
		return { url: '', number: null, action: 'dry-run' };
	}

	const existing = (await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
		owner: params.owner,
		repo: params.repo,
		state: 'open',
		labels: params.labels.join(','),
		per_page: 100,
	})) as Array<{ number: number; html_url: string; updated_at: string; pull_request?: object }>;

	// /issues returns PRs too — filter them out so a labelled PR doesn't get
	// misinterpreted as our audit issue.
	const matches = existing.filter((i) => !i.pull_request);

	if (matches.length === 0) {
		const created = await octokit.request('POST /repos/{owner}/{repo}/issues', {
			owner: params.owner,
			repo: params.repo,
			title: params.title,
			body: params.body,
			labels: [...params.labels],
		});
		const data = created.data as { number: number; html_url: string };
		core.info(`opened issue #${data.number} in ${params.owner}/${params.repo}`);
		return { url: data.html_url, number: data.number, action: 'created' };
	}

	if (matches.length > 1) {
		core.warning(
			`found ${matches.length} open audit issues in ${params.owner}/${params.repo}; updating most recently updated`,
		);
	}

	matches.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
	const target = matches[0];

	await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
		owner: params.owner,
		repo: params.repo,
		issue_number: target.number,
		body: params.body,
	});
	// Comment is the visible signal a re-run happened — body overwrites silently.
	await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
		owner: params.owner,
		repo: params.repo,
		issue_number: target.number,
		body: `Re-audited at ${params.runAt}`,
	});
	core.info(`updated issue #${target.number} in ${params.owner}/${params.repo}`);
	return { url: target.html_url, number: target.number, action: 'updated' };
}
