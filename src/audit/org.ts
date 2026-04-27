import * as core from '@actions/core';
import { isWithinWindow, maxIso, type ActivityCache } from '../github/cache.js';
import { mapWithConcurrency } from '../concurrency.js';
import { filterMembers } from '../filter.js';
import { listOrgMembers } from '../github/members.js';
import type { AuditError, InactiveMember, InactivityReason, OrgAuditResult } from '../types.js';
import type { RepoFilter } from './graphql.js';
import { probeUserActivity, type UserProbeCache } from './probing.js';
import { intersectsIgnored } from '../filter.js';

export async function auditOrg(
	cache: UserProbeCache,
	teamMap: ReadonlyMap<string, ReadonlySet<string>>,
	cacheData: ActivityCache,
): Promise<OrgAuditResult> {
	const { octokit, cfg } = cache.ctx;
	const allMembers = await listOrgMembers(octokit, cfg.org, cfg.includeOutsideCollaborators);
	const filtered = filterMembers(allMembers, cfg);

	const candidates: string[] = [];
	for (const login of filtered) {
		const userTeams = teamMap.get(login) ?? new Set<string>();
		const hitsIgnored = intersectsIgnored(userTeams, cfg.ignoreTeams);
		if (hitsIgnored) {
			core.info(`skipped @${login} (member of ignored team: ${hitsIgnored})`);
			continue;
		}
		candidates.push(login);
	}

	// Fast path: if the persisted cache already proves the user was active
	// inside the current window, we can skip the GraphQL probe entirely.
	const needsProbe: string[] = [];
	const skippedByCache: string[] = [];
	for (const login of candidates) {
		if (isWithinWindow(cacheData.org[login], cfg.since)) skippedByCache.push(login);
		else needsProbe.push(login);
	}
	if (skippedByCache.length > 0) {
		core.info(
			`org audit: cache proved ${skippedByCache.length}/${candidates.length} members active without API calls`,
		);
	}

	// Org audit is "active anywhere except in ignored repos".
	const repoFilter: RepoFilter = (r) => !cfg.ignoreRepositories.has(r);

	const errors: AuditError[] = [];
	const inactive: InactiveMember[] = [];

	// `lastSeen` reported in the result is always read from the cache after any
	// updates this run made. That's what makes lastSeen accurate beyond
	// `inactivityDays`: a member last seen 400 days ago appears with their
	// actual prior date instead of `null`.
	const classify = (
		login: string,
		hasActivity: boolean,
	): { reason: InactivityReason; teams: string[] } | null => {
		const teams = [...(teamMap.get(login) ?? new Set<string>())];
		const noTeam = teams.length === 0;
		const noActivity = !hasActivity;
		if (!noActivity && !noTeam) return null;
		const reason: InactivityReason =
			noActivity && noTeam ? 'no-activity, no-team' : noActivity ? 'no-activity' : 'no-team';
		return { reason, teams };
	};

	for (const login of skippedByCache) {
		const decision = classify(login, true);
		if (!decision) {
			core.info(`audited @${login} as active (cached)`);
			continue;
		}
		core.info(`audited @${login} as inactive (${decision.reason}) [cached]`);
		inactive.push({
			login,
			reason: decision.reason,
			teams: decision.teams,
			lastSeen: cacheData.org[login] ?? null,
		});
	}

	await mapWithConcurrency(needsProbe, cfg.concurrency, async (login) => {
		try {
			const sig = await probeUserActivity(cache, login, repoFilter);

			const merged = maxIso(cacheData.org[login], sig.lastSeen);
			if (merged) cacheData.org[login] = merged;

			const decision = classify(login, sig.hasActivity);
			if (!decision) {
				core.info(`audited @${login} as active`);
				return;
			}
			core.info(`audited @${login} as inactive (${decision.reason})`);
			inactive.push({
				login,
				reason: decision.reason,
				teams: decision.teams,
				lastSeen: cacheData.org[login] ?? null,
			});
		} catch (err) {
			// One failed probe must not abort the whole audit. Capture and surface
			// in the report's Errors section so the user can investigate.
			const cause = err instanceof Error ? err.message : String(err);
			core.warning(`org audit: skipping @${login} due to error: ${cause}`);
			errors.push({ login, cause });
		}
	});

	inactive.sort((a, b) => a.login.localeCompare(b.login));
	const noTeamCount = inactive.filter((m) => m.reason !== 'no-activity').length;
	const noActivityCount = inactive.filter((m) => m.reason !== 'no-team').length;
	const bothCount = inactive.filter((m) => m.reason === 'no-activity, no-team').length;

	return {
		org: cfg.org,
		totalAudited: candidates.length,
		inactive,
		errors,
		noTeamCount,
		noActivityCount,
		bothCount,
		runAt: cfg.now,
	};
}
