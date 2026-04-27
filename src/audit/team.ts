import * as core from '@actions/core';
import { isWithinWindow, maxIso, type ActivityCache } from '../github/cache.js';
import { mapWithConcurrency } from '../concurrency.js';
import { filterMembers } from '../filter.js';
import {
	listTeamMembers,
	listTeamRepos,
	type TeamDiscovery,
	type TeamRepo,
} from '../github/teams.js';
import type { AuditError, InactiveMember, TeamAuditResult } from '../types.js';
import type { RepoFilter } from './graphql.js';
import { probeUserActivity, type UserProbeCache } from './probing.js';
import { intersectsIgnored } from '../filter.js';

export async function auditTeam(
	cache: UserProbeCache,
	slug: string,
	reportRepo: { owner: string; repo: string },
	teamMap: ReadonlyMap<string, ReadonlySet<string>>,
	cacheData: ActivityCache,
): Promise<TeamAuditResult | null> {
	const { octokit, cfg } = cache.ctx;

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
	const teamRepos = new Set(
		rawRepos
			.filter((r) => !r.archived && !cfg.ignoreRepositories.has(`${r.owner}/${r.repo}`))
			.map((r) => `${r.owner}/${r.repo}`),
	);

	const teamCache: Record<string, string> = cacheData.teams[slug] ?? (cacheData.teams[slug] = {});

	if (teamRepos.size === 0) {
		// Nothing to probe against: by the team-scoped definition every member is
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
				lastSeen: teamCache[login] ?? null,
			})),
			auditedRepos: [],
			errors: [],
			runAt: cfg.now,
		};
	}

	// Cache fast path: if the persisted cache proves the user was active inside
	// the current window for THIS team, skip the GraphQL probes entirely.
	const needsProbe: string[] = [];
	const skippedByCache: string[] = [];
	for (const login of members) {
		if (isWithinWindow(teamCache[login], cfg.since)) skippedByCache.push(login);
		else needsProbe.push(login);
	}
	if (skippedByCache.length > 0) {
		core.info(
			`team audit "${slug}": cache proved ${skippedByCache.length}/${members.length} members active without API calls`,
		);
	}
	for (const login of skippedByCache) {
		core.info(`audited @${login} in team "${slug}" as active (cached)`);
	}

	// Team audit is "active in any of the team's auditable repos".
	const repoFilter: RepoFilter = (r) => teamRepos.has(r);

	const errors: AuditError[] = [];
	const inactive: InactiveMember[] = [];

	await mapWithConcurrency(needsProbe, cfg.concurrency, async (login) => {
		try {
			// Time-bounded check via contributionsCollection. The per-repo
			// breakdowns let us decide team-scoped activity in the window without
			// per-repo polling. The probe cache deduplicates this fetch across the
			// org audit and any other team audits the user appears in.
			const sig = await probeUserActivity(cache, login, repoFilter);

			const merged = maxIso(teamCache[login], sig.lastSeen);
			if (merged) teamCache[login] = merged;

			if (sig.hasActivity) {
				core.info(`audited @${login} in team "${slug}" as active`);
			} else {
				core.info(`audited @${login} in team "${slug}" as inactive (no-activity)`);
				inactive.push({
					login,
					reason: 'no-activity',
					teams: [slug],
					lastSeen: teamCache[login] ?? null,
				});
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
		auditedRepos: [...teamRepos].sort(),
		errors,
		runAt: cfg.now,
	};
}

// Sequential rather than parallel: each team audit is itself parallel across
// its members, so stacking outer concurrency would multiply the burst. The
// shared probe cache keeps duplicate-member probes cheap regardless of order.
export async function auditTeams(
	cache: UserProbeCache,
	discovery: TeamDiscovery,
	cacheData: ActivityCache,
): Promise<TeamAuditResult[]> {
	const results: TeamAuditResult[] = [];
	for (const [slug, repo] of discovery.reportRepos) {
		const result = await auditTeam(cache, slug, repo, discovery.membership, cacheData);
		if (result) results.push(result);
	}
	return results;
}
