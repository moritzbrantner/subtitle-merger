# Agent instructions

## Working rules

- Read `docs/adr/0003-released-native-whisperx-boundary.md` before changing transcription or translation integration.
- Use source development mode when Subtitle Merger needs unreleased Native WhisperX or audio-stack behavior.
- Do not publish Cargo or npm packages merely to unblock application work.
- Treat Subtitle Merger as the vertical consumer: drive Native WhisperX changes from concrete editor and subtitle workflows.
- Keep a normal task to this repository plus at most two upstream repositories unless broader migration scope was explicitly assigned.
- Keep application-local frontend packages source-local; npm publication is not part of ordinary development.
- Registry-only Native WhisperX resolution is required for release, not for source-mode feature evidence.

## Agent skills

This repository is configured for the Matt Pocock workflow skills and the agent-loop control plane.

- Issue tracker: `docs/agents/issue-tracker.md`
- Triage labels: `docs/agents/triage-labels.md`
- Domain context: `docs/agents/domain.md`
- Planning workflow: `docs/agents/planning-workflow.md`

### Planning workflow

Substantial new work should be planned into GitHub PRD issues instead of implemented directly. See `docs/agents/planning-workflow.md`.
