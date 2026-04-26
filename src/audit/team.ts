import * as core from '@actions/core';
import { mapWithConcurrency } from '../concurrency.js';
import { filterMembers } from '../filter.js';
import { listTeamMembers, listTeamRepos, type TeamRepo } from '../github/teams.js';
import type {
	AuditConfig,
	AuditError,
	InactiveMember,
	Octokit,
	TeamAuditResult,
} from '../types.js';
import { probeRepo } from './activity-rest.js';

function intersectsIgnored(
	userTeams: ReadonlySet<string>,
	ignoreTeams: ReadonlySet<string>,
): string | null {
	for (const t of userTeams) {
		if (ignoreTeams.has(t)) return t;
	}
	return null;
}

export async function auditTeam(
	octokit: Octokit,
	cfg: AuditConfig,
	slug: string,
	reportRepo: { owner: string; repo: string },
	teamMap: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<TeamAuditResult | null> {
	let rawMembers: string[];
	let rawRepos: TeamRepo[];
	try {
		[rawMembers, rawRepos] = await Promise.all([
			listTeamMembers(octokit, cfg.org, slug),
			listTeamRepos(octokit, cfg.org, slug),
		]);
	} catch (err) {
		// A bad team-map entry (typo, deleted team) should warn and continue, not
		// take down the whole run.
		const cause = err instanceof Error ? err.message : String(err);
		core.warning(`team audit "${slug}": failed to list members or repos (${cause}); skipping`);
		return null;
	}

	const preFilter = filterMembers(rawMembers, cfg);
	const members: string[] = [];
	for (const login of preFilter) {
		const userTeams = teamMap.get(login) ?? new Set<string>();
		const hitsIgnored = intersectsIgnored(userTeams, cfg.ignoreTeams);
		if (hitsIgnored) {
			core.info(`skipped @${login} in team "${slug}" (member of ignored team: ${hitsIgnored})`);
			continue;
		}
		members.push(login);
	}
	const repos = rawRepos.filter(
		(r) => !r.archived && !cfg.ignoreRepositories.has(`${r.owner}/${r.repo}`),
	);

	if (repos.length === 0) {
		// Nothing to probe against — by the team-scoped definition every member is
		// trivially inactive. Surface that explicitly so the report is honest.
		core.warning(`team audit "${slug}": no auditable repos (after filtering archived/ignored)`);
		for (const login of members) {
			core.info(`audited @${login} in team "${slug}" as inactive (no auditable repos)`);
		}
		return {
			slug,
			reportRepo,
			totalAudited: members.length,
			inactive: members.map<InactiveMember>((login) => ({
				login,
				reason: 'no-activity',
				teams: [slug],
				lastSeen: null,
			})),
			auditedRepos: [],
			errors: [],
			runAt: cfg.now,
		};
	}

	const errors: AuditError[] = [];
	const inactive: InactiveMember[] = [];

	await mapWithConcurrency(members, cfg.concurrency, async (login) => {
		try {
			let active = false;
			let latest: string | null = null;
			// Walk the team's repos in series for a single member; the parallelism
			// is across members. This keeps the per-member burst bounded and lets
			// us short-circuit cheaply on the first hit.
			for (const r of repos) {
				const sig = await probeRepo(
					octokit,
					r.owner,
					r.repo,
					login,
					cfg.since,
					cfg.interactionTypes,
				);
				if (sig.hasActivity) {
					active = true;
					break;
				}
				if (sig.lastSeen && (!latest || sig.lastSeen > latest)) latest = sig.lastSeen;
			}
			if (active) {
				core.info(`audited @${login} in team "${slug}" as active`);
			} else {
				core.info(`audited @${login} in team "${slug}" as inactive (no-activity)`);
				inactive.push({ login, reason: 'no-activity', teams: [slug], lastSeen: latest });
			}
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			core.warning(`team audit "${slug}": skipping @${login} due to error: ${cause}`);
			errors.push({ login, cause });
		}
	});

	inactive.sort((a, b) => a.login.localeCompare(b.login));

	return {
		slug,
		reportRepo,
		totalAudited: members.length,
		inactive,
		auditedRepos: repos.map((r) => `${r.owner}/${r.repo}`),
		errors,
		runAt: cfg.now,
	};
}

// Sequential rather than parallel: each team audit is itself parallel across
// its members, so stacking outer concurrency would multiply the burst.
export async function auditTeams(
	octokit: Octokit,
	cfg: AuditConfig,
	teamMap: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<TeamAuditResult[]> {
	const results: TeamAuditResult[] = [];
	for (const [slug, repo] of Object.entries(cfg.teamMap)) {
		const result = await auditTeam(octokit, cfg, slug, repo, teamMap);
		if (result) results.push(result);
	}
	return results;
}
