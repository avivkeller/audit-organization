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

	const { data: existing } = await octokit.request('GET /repos/{owner}/{repo}/issues', {
		owner: params.owner,
		repo: params.repo,
		state: 'open',
		labels: params.labels.join(','),
		per_page: 1,
	});

	if (existing.length === 0) {
		const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
			owner: params.owner,
			repo: params.repo,
			title: params.title,
			body: params.body,
			labels: [...params.labels],
		});
		core.info(`opened issue #${data.number} in ${params.owner}/${params.repo}`);
		return { url: data.html_url, number: data.number, action: 'created' };
	}

	await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
		owner: params.owner,
		repo: params.repo,
		issue_number: existing[0].number,
		body: params.body,
	});

	core.info(`updated issue #${existing[0].number} in ${params.owner}/${params.repo}`);
	return { url: existing[0].html_url, number: existing[0].number, action: 'updated' };
}
