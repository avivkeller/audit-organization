import * as core from '@actions/core';
import { auditOrg } from './audit/org.js';
import { auditTeams } from './audit/team.js';
import { createContext, UserProbeCache } from './audit/probing.js';
import { restoreActivityCache, runMarkerFromIso, saveActivityCache } from './github/cache.js';
import { buildTeamMap } from './github/teams.js';
import { upsertIssue } from './github/issue.js';
import { parseInputs } from './inputs.js';
import { buildClient } from './octokit.js';
import { renderOrgReport, renderTeamReport } from './report.js';

export async function run(): Promise<void> {
	const cfg = parseInputs();
	core.info(`auditing ${cfg.org} (window: ${cfg.inactivityDays}d, dry-run: ${cfg.dryRun})`);
	const octokit = buildClient(cfg.token);

	// One probe cache shared across the org audit and every team audit, so a
	// member who appears in N audits costs at most one fetchOrgActivity call
	// (and one fetchUserCommentsInOrg call) for the whole run.
	const probeCache = new UserProbeCache(createContext(octokit, cfg));

	// One team discovery pass: yields both the login→teams membership index
	// (for ignore-teams filtering and the org audit's no-team verdict) and the
	// slug→reportRepo map parsed from team descriptions (replaces the old
	// `team-map` config input).
	const discovery = await buildTeamMap(octokit, cfg.org);

	const runMarker = runMarkerFromIso(cfg.now);
	const cacheData = await restoreActivityCache(cfg.org, runMarker);
	// Save in `finally` so a partial failure still persists whatever fresh
	// activity data the run gathered. The next run benefits even on crash.
	try {
		const orgResult = await auditOrg(probeCache, discovery.membership, cacheData);
		core.info(
			`org audit done: ${orgResult.inactive.length}/${orgResult.totalAudited} inactive, ${orgResult.errors.length} errors`,
		);

		const orgRendered = renderOrgReport(orgResult, cfg);
		const orgIssue = await upsertIssue(octokit, {
			owner: cfg.reportRepo.owner,
			repo: cfg.reportRepo.repo,
			title: orgRendered.title,
			body: orgRendered.body,
			labels: orgRendered.labels,
			dryRun: cfg.dryRun,
			runAt: cfg.now,
		});
		core.setOutput('inactive-count', String(orgResult.inactive.length));
		core.setOutput('issue-url', orgIssue.url);

		if (discovery.reportRepos.size === 0) {
			core.info(
				'no teams advertise a `repo:` token in their description; skipping per-team audits',
			);
			return;
		}

		core.info(`running per-team audits for ${discovery.reportRepos.size} teams`);
		const teamResults = await auditTeams(probeCache, discovery, cacheData);
		for (const teamResult of teamResults) {
			const rendered = renderTeamReport(teamResult, cfg);
			await upsertIssue(octokit, {
				owner: teamResult.reportRepo.owner,
				repo: teamResult.reportRepo.repo,
				title: rendered.title,
				body: rendered.body,
				labels: rendered.labels,
				dryRun: cfg.dryRun,
				runAt: cfg.now,
			});
		}
	} finally {
		await saveActivityCache(cfg.org, runMarker, cacheData);
	}
}
