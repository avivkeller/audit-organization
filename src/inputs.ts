import * as core from '@actions/core';
import { context } from '@actions/github';
import { ALL_INTERACTION_TYPES, type AuditConfig, type InteractionType } from './types.js';

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseRepoFullName(value: string, field: string): { owner: string; repo: string } {
	if (!REPO_PATTERN.test(value)) {
		throw new Error(`${field}: expected "owner/repo", got "${value}"`);
	}
	const [owner, repo] = value.split('/');
	return { owner, repo };
}

function parseCsvSet(value: string): Set<string> {
	if (!value.trim()) return new Set();
	return new Set(
		value
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	);
}

function parseTeamMap(raw: string): Record<string, { owner: string; repo: string }> {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === '{}') return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(`team-map: invalid JSON (${cause})`, { cause: err });
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('team-map: expected a JSON object mapping team slug -> "owner/repo"');
	}
	const out: Record<string, { owner: string; repo: string }> = {};
	for (const [slug, repoFullName] of Object.entries(parsed)) {
		if (!slug.trim()) {
			throw new Error('team-map: team slug must be non-empty');
		}
		if (typeof repoFullName !== 'string') {
			throw new Error(`team-map[${slug}]: value must be a string "owner/repo"`);
		}
		out[slug] = parseRepoFullName(repoFullName, `team-map[${slug}]`);
	}
	return out;
}

function parseInteractionTypes(value: string): Set<InteractionType> {
	const csv = parseCsvSet(value);
	if (csv.size === 0) {
		throw new Error('interaction-types: at least one type must be specified');
	}
	const valid = new Set<string>(ALL_INTERACTION_TYPES);
	for (const t of csv) {
		if (!valid.has(t)) {
			throw new Error(
				`interaction-types: unknown type "${t}". Allowed: ${ALL_INTERACTION_TYPES.join(', ')}`,
			);
		}
	}
	return csv as Set<InteractionType>;
}

function parsePositiveInt(value: string, field: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`${field}: expected a positive integer, got "${value}"`);
	}
	return n;
}

function parseBool(value: string): boolean {
	return value.toLowerCase() === 'true';
}

// `context.repo` throws synchronously when GITHUB_REPOSITORY is unset, so we
// can't read it eagerly at module load — that breaks tests and `local-action`.
function resolveContextRepo(): { owner: string; repo: string } | null {
	if (!process.env.GITHUB_REPOSITORY) return null;
	return context.repo;
}

// Surface choices that visibly slow the run or produce surprising reports, so
// the auditor sees them at the top of the action log instead of debugging
// mysterious latency or noisy output later.
function warnAboutExpensiveChoices(cfg: {
	interactionTypes: ReadonlySet<InteractionType>;
	concurrency: number;
	includeOutsideCollaborators: boolean;
	teamMap: Record<string, unknown>;
}): void {
	if (cfg.interactionTypes.has('pr-review')) {
		core.warning(
			"interaction-types includes pr-review: this fetches recent PRs and inspects each PR's reviews per audited member — slowest signal, expect higher API usage",
		);
	}
	const wantsComments =
		cfg.interactionTypes.has('issue-comment') || cfg.interactionTypes.has('pr-comment');
	if (wantsComments) {
		core.warning(
			'interaction-types includes issue/pr comments: comments must be paginated and filtered client-side, plus an org-wide search call per member — moderately slow',
		);
	}
	if (cfg.concurrency > 10) {
		core.warning(
			`concurrency=${cfg.concurrency} is high: increases the chance of secondary rate-limit (abuse-detection) hits`,
		);
	}
	if (cfg.includeOutsideCollaborators) {
		core.warning(
			'include-outside-collaborators=true: outside collaborators cannot belong to teams and will all be flagged as no-team in the org-wide audit',
		);
	}
	if (Object.keys(cfg.teamMap).length > 20) {
		core.warning(
			`team-map has ${Object.keys(cfg.teamMap).length} entries: each team triggers a per-repo REST sweep — expect a long-running audit`,
		);
	}
}

export function parseInputs(): AuditConfig {
	const org = core.getInput('org', { required: true }).trim();
	if (!org) throw new Error('org: required');

	const token = core.getInput('token', { required: true }).trim();
	if (!token) throw new Error('token: required');

	const reportRepoRaw = core.getInput('report-repo').trim();
	let reportRepo: { owner: string; repo: string };
	if (reportRepoRaw) {
		reportRepo = parseRepoFullName(reportRepoRaw, 'report-repo');
	} else {
		const ctxRepo = resolveContextRepo();
		if (!ctxRepo) {
			throw new Error(
				'report-repo: not provided and the action context has no owner/repo (run inside GitHub Actions or pass report-repo explicitly)',
			);
		}
		reportRepo = { owner: ctxRepo.owner, repo: ctxRepo.repo };
	}

	const inactivityDays = parsePositiveInt(
		core.getInput('inactivity-days') || '90',
		'inactivity-days',
	);

	const teamMap = parseTeamMap(core.getInput('team-map') || '{}');
	const dryRun = parseBool(core.getInput('dry-run') || 'false');

	const ignoreRepositories = parseCsvSet(core.getInput('ignore-repositories'));
	for (const repo of ignoreRepositories) {
		if (!REPO_PATTERN.test(repo)) {
			throw new Error(`ignore-repositories: "${repo}" is not "owner/repo"`);
		}
	}

	const ignoreMembers = parseCsvSet(core.getInput('ignore-members'));
	const ignoreTeams = parseCsvSet(core.getInput('ignore-teams'));
	const includeOutsideCollaborators = parseBool(
		core.getInput('include-outside-collaborators') || 'false',
	);
	const includeBots = parseBool(core.getInput('include-bots') || 'false');
	const interactionTypes = parseInteractionTypes(
		core.getInput('interaction-types') || 'commit,pr,pr-review,issue',
	);
	const concurrency = parsePositiveInt(core.getInput('concurrency') || '5', 'concurrency');

	warnAboutExpensiveChoices({
		interactionTypes,
		concurrency,
		includeOutsideCollaborators,
		teamMap,
	});

	const nowDate = new Date();
	const sinceDate = new Date(nowDate.getTime() - inactivityDays * 24 * 60 * 60 * 1000);

	return Object.freeze({
		org,
		token,
		reportRepo: Object.freeze(reportRepo),
		inactivityDays,
		since: sinceDate.toISOString(),
		now: nowDate.toISOString(),
		teamMap: Object.freeze(teamMap),
		dryRun,
		ignoreRepositories,
		ignoreMembers,
		ignoreTeams,
		includeOutsideCollaborators,
		includeBots,
		interactionTypes,
		concurrency,
	});
}
