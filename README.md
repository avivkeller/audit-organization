# organization-auditor

A GitHub Action that audits a GitHub organization for inactive members and files a tracking issue with the report. **Never removes anyone** - it only reports.

## What "inactive" means

A member is **inactive** if **either**:

1. They have had no interaction (commit, PR opened, PR review, issue opened, optionally comments) in any org repo for the last N days (default 90), **or**
2. They are not a member of any team.

Per-team audits are opt-in **per team**, via the team's GitHub description: include a token of the form `repo: owner/board-repo` (or `repo: [owner/board-repo]`) anywhere in the description, and the action will audit that team and file its report issue in the named repo. Teams without the token are skipped. A team member is inactive in this audit if they have had no interaction with any of the team's repositories in the window.

## Usage

```yaml
name: Audit organization
on:
  schedule:
    - cron: '0 9 * * 1' # every Monday 09:00 UTC
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: avivkeller/organization-auditor@v1
        with:
          org: my-org
          token: ${{ secrets.ORG_AUDIT_TOKEN }}
          inactivity-days: 90
          ignore-members: 'svc-deploy,svc-backup'
```

### Token

The default `GITHUB_TOKEN` is **not sufficient** - it is scoped to the running repository, but this action needs to read org membership, teams, and contributions across the org.

You must provide a token with:

- `read:org` (list members, teams, team membership)
- `repo` (read commits/issues/PRs/comments across org repos)

A **fine-grained PAT** owned by an org admin or a **GitHub App installation token** with the equivalent permissions both work. Pass it via the `token` input.

## Inputs

| Input                           | Required | Default                     | Notes                                                                                                                                                          |
| ------------------------------- | :------: | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org`                           |    ✓     |                             | Organization login.                                                                                                                                            |
| `token`                         |    ✓     |                             | PAT or GitHub App token with `read:org` + `repo`.                                                                                                              |
| `report-repo`                   |          | running repo                | `owner/repo` for the org-wide report issue.                                                                                                                    |
| `inactivity-days`               |          | `90`                        | Window in days for the activity check.                                                                                                                         |
| `dry-run`                       |          | `false`                     | If `true`, log the report instead of opening/updating an issue.                                                                                                |
| `ignore-repositories`           |          | `''`                        | Comma-separated `owner/repo` entries excluded from activity scoring.                                                                                           |
| `ignore-members`                |          | `''`                        | Comma-separated logins excluded from the audit.                                                                                                                |
| `ignore-teams`                  |          | `''`                        | Comma-separated team slugs whose members are excluded from the audit.                                                                                          |
| `include-outside-collaborators` |          | `false`                     | Also audit outside collaborators.                                                                                                                              |
| `include-bots`                  |          | `false`                     | Audit logins ending in `[bot]`. Default skips them.                                                                                                            |
| `interaction-types`             |          | `commit,pr,pr-review,issue` | Comma-separated allowlist: `commit,pr,pr-review,pr-comment,issue,issue-comment`. Including `issue-comment` / `pr-comment` auto-engages slower comment probing. |
| `concurrency`                   |          | `5`                         | Max parallel per-member probes.                                                                                                                                |

## Outputs

| Output           | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `inactive-count` | Total inactive members in the org-wide report.       |
| `issue-url`      | URL of the org-wide report issue (empty in dry-run). |

## Caching

The action uses [`@actions/cache`](https://github.com/actions/toolkit/tree/main/packages/cache) to persist the most recent observed `lastSeen` per member across runs. This has two effects:

1. **Faster runs.** When a cached `lastSeen` falls inside the current inactivity window, the action skips the API probe for that member entirely.
2. **Accurate `lastSeen` over any duration.** A member's reported `lastSeen` is read from the cache, so a person last active 400 days ago shows their actual prior date even with a 90-day window. Without the cache, `lastSeen` could only ever resolve to a date inside the window.

The cache is keyed by org and is automatic - no extra configuration is required. When running outside GitHub Actions (e.g. via `local-action`), caching transparently no-ops and the audit behaves exactly as before.

## License

[MIT](LICENSE)
