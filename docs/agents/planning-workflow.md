# Planning Workflow

The repository development loop is independent of orchestration. A direct local or hosted implementation task may work from a bounded user request without first creating GitHub planning artifacts.

When the agent-loop is used, GitHub provides the durable queue and the installed agent-loop skills provide the orchestration procedure. Repository-specific facts stay in `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md`.

For orchestrated work:

- Use a PRD issue when durable multi-slice planning is useful.
- Implementation slice issues should link their parent PRD before receiving `ready-for-agent`.
- The agent-loop may slice and route ready work, but it does not redefine repository completion gates.

Do not make a particular local skill path, hosted model policy, GitHub issue state, or orchestrator runtime a prerequisite for ordinary repository development.
