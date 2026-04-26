import * as core from '@actions/core';
import { mapWithConcurrency } from '../concurrency.js';
import { filterMembers } from '../filter.js';
import { listOrgMembers } from '../github/members.js';
import type {
	AuditConfig,
	AuditError,
	InactiveMember,
	InactivityReason,
	Octokit,
	OrgAuditResult,
} from '../types.js';
import { probeOrgComments } from './activity-comments.js';
import { activityFromContributions, fetchOrgActivity, fetchOrgId } from './activity-graphql.js';

function intersectsIgnored(
	userTeams: ReadonlySet<string>,
	ignoreTeams: ReadonlySet<string>,
): string | null {
	for (const t of userTeams) {
		if (ignoreTeams.has(t)) return t;
	}
	return null;
}

export async function auditOrg(
	octokit: Octokit,
	cfg: AuditConfig,
	teamMap: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<OrgAuditResult> {
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

	const orgId = await fetchOrgId(octokit, cfg.org);

	// Comment-aware probing kicks in automatically when the user opted into
	// issue-comment / pr-comment via interaction-types. The org-wide signal
	// uses the Search API; the team audit uses REST per repo.
	const wantsComments =
		cfg.interactionTypes.has('issue-comment') || cfg.interactionTypes.has('pr-comment');

	const errors: AuditError[] = [];
	const inactive: InactiveMember[] = [];

	await mapWithConcurrency(candidates, cfg.concurrency, async (login) => {
		try {
			const teams = [...(teamMap.get(login) ?? new Set<string>())];
			const noTeam = teams.length === 0;

			const contributions = await fetchOrgActivity(octokit, login, orgId, cfg.since, cfg.now);
			const sig = activityFromContributions(contributions, cfg.ignoreRepositories);

			let hasActivity = sig.hasActivity;
			if (!hasActivity && wantsComments) {
				const commentSig = await probeOrgComments(octokit, login, cfg.org, cfg.since);
				hasActivity = commentSig.hasActivity;
			}

			const noActivity = !hasActivity;
			if (!noActivity && !noTeam) {
				core.info(`audited @${login} as active`);
				return;
			}

			let reason: InactivityReason;
			if (noActivity && noTeam) reason = 'no-activity, no-team';
			else if (noActivity) reason = 'no-activity';
			else reason = 'no-team';

			core.info(`audited @${login} as inactive (${reason})`);
			inactive.push({ login, reason, teams, lastSeen: sig.lastSeen });
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
