# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

Agent-loop work also uses these labels:

| Label | Meaning |
| --- | --- |
| `prd` | Product requirements document ready for workflow routing |
| `agent-loop:claimed` | Claimed by the agent-loop master |
| `agent-loop:in-progress` | Work is active in an agent-loop worker |
| `agent-loop:blocked` | Blocked on human input or external access |
| `agent-loop:ready-to-merge` | Worker reports the PR is ready to merge |
| `agent-loop:merged` | Associated PR has been merged |
| `agent-loop:done` | Agent-loop work is complete |
| `agent-loop:failed` | Automation failed and needs review |

When a skill mentions a role, use the corresponding label string from these tables.
