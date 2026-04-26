# organization-auditor

A GitHub Action that audits a GitHub organization for inactive members and files a tracking issue with the report. **Never removes anyone** — it only reports.

## What "inactive" means

A member is **inactive** if **either**:

1. They have had no interaction (commit, PR opened, PR review, issue opened, optionally comments) in any org repo for the last N days (default 90), **or**
2. They are not a member of any team.

If a `team-map` is supplied, the action additionally runs a per-team audit: a team member is inactive if they have had no interaction with the team's repositories in the window. Each team's report is filed as an issue in the repo specified for that team.

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
          team-map: |
            {
              "infra": "my-org/infra-board",
              "data": "my-org/data-board"
            }
```

### Token

The default `GITHUB_TOKEN` is **not sufficient** — it is scoped to the running repository, but this action needs to read org membership, teams, and contributions across the org.

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
| `team-map`                      |          | `{}`                        | JSON `{teamSlug: "owner/repo"}`. Triggers per-team audits.                                                                                                     |
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

## License

[MIT](LICENSE)
