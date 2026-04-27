import * as core from '@actions/core';
import { GitHub, getOctokitOptions } from '@actions/github/lib/utils';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import type { Octokit } from './types.js';

interface ThrottleOptions {
	method: string;
	url: string;
}

// throttling: handles primary + secondary rate-limit responses with backoff.
// retry: handles transient 5xx and network failures.
const ThrottledGitHub = GitHub.plugin(throttling, retry);

export function buildClient(token: string): Octokit {
	const options = getOctokitOptions(token, {
		throttle: {
			// Primary rate-limit (5000/hr authenticated). Retry up to 3 times - past
			// that, the budget is genuinely exhausted and waiting longer rarely helps.
			onRateLimit: (
				retryAfter: number,
				options: ThrottleOptions,
				_octokit: unknown,
				retryCount: number,
			) => {
				core.warning(
					`Rate limit hit on ${options.method} ${options.url}. Retrying after ${retryAfter}s (attempt ${retryCount + 1}).`,
				);
				return retryCount < 3;
			},
			// Secondary rate-limit (concurrent / abuse-detection). Retry once;
			// repeat hits usually mean the call pattern itself is the problem.
			onSecondaryRateLimit: (
				retryAfter: number,
				options: ThrottleOptions,
				_octokit: unknown,
				retryCount: number,
			) => {
				core.warning(
					`Secondary rate limit hit on ${options.method} ${options.url}. Retrying after ${retryAfter}s (attempt ${retryCount + 1}).`,
				);
				return retryCount < 2;
			},
		},
		retry: {
			// 429 is rate-limit; the throttling plugin owns retry for those, so the
			// retry plugin must not double-retry.
			doNotRetry: [429],
		},
	});
	return new ThrottledGitHub(options) as unknown as Octokit;
}
