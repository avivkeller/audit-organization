import * as core from '@actions/core';
import { auditOrg } from './audit/org.js';
import { auditTeams } from './audit/team.js';
import { buildTeamMap } from './github/teams.js';
import { upsertIssue } from './github/issue.js';
import { parseInputs } from './inputs.js';
import { buildClient } from './octokit.js';
import { renderOrgReport, renderTeamReport } from './report.js';

export async function run(): Promise<void> {
	const cfg = parseInputs();
	core.info(`auditing ${cfg.org} (window: ${cfg.inactivityDays}d, dry-run: ${cfg.dryRun})`);
	const octokit = buildClient(cfg.token);

	// Single team-map shared by both audit modes — needed by org audit for the
	// no-team verdict, and by both audits for ignore-teams filtering.
	const teamMap = await buildTeamMap(octokit, cfg.org);

	const orgResult = await auditOrg(octokit, cfg, teamMap);
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

	const teamSlugs = Object.keys(cfg.teamMap);
	if (teamSlugs.length === 0) {
		core.info('team-map empty; skipping per-team audits');
		return;
	}

	core.info(`running per-team audits for ${teamSlugs.length} teams`);
	const teamResults = await auditTeams(octokit, cfg, teamMap);
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
}
