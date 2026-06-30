# Planning Workflow

This repository uses the canonical agent-loop setup for generic planning workflow rules. See `~/.codex/skills/moenarch-setup-agent-loop-skills/planning-workflow.md`.

Repo-specific facts stay in `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md`.

Summary:

- GitHub Issues are the durable work queue.
- Substantial work starts as a PRD issue labeled `prd` and `ready-for-agent`.
- Implementation slice issues must include a `## Parent` link to their parent PRD before they receive `ready-for-agent`.
- The agent-loop handles slicing and routing after the PRD is ready.

## Model policy

Agent-loop workers use the hosted model policy from the installed `moenarch-agent-loop` skill. See `~/.codex/skills/moenarch-agent-loop/references/model-policy.md`.
