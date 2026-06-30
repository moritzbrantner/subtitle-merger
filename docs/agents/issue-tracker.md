# Issue Tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `moritzbrantner/subtitle-merger`. Use the `gh` CLI or the GitHub connector for all issue operations.

## Conventions

- Create an issue: `gh issue create --repo moritzbrantner/subtitle-merger --title "..." --body "..."`
- Read an issue: `gh issue view <number> --repo moritzbrantner/subtitle-merger --comments`
- List issues: `gh issue list --repo moritzbrantner/subtitle-merger --state open --json number,title,body,labels,comments`
- Comment on an issue: `gh issue comment <number> --repo moritzbrantner/subtitle-merger --body "..."`
- Apply or remove labels: `gh issue edit <number> --repo moritzbrantner/subtitle-merger --add-label "..."` or `--remove-label "..."`
- Close an issue: `gh issue close <number> --repo moritzbrantner/subtitle-merger --comment "..."`

## Publishing Work

When a skill says "publish to the issue tracker", create a GitHub issue in `moritzbrantner/subtitle-merger`.

When a skill says "fetch the relevant ticket", run `gh issue view <number> --repo moritzbrantner/subtitle-merger --comments`.
