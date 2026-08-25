# Agent instructions

## Applicable convention stack

Apply the shared conventions from `moritzbrantner/coding-agent-conventions` without copying them here:

- `principles/`
- `conventions/agents/`
- `conventions/dependencies/`
- `conventions/environment/`
- `conventions/interface-design/`
- `conventions/repository/`
- `conventions/testing/`
- `technologies/rust/`
- `technologies/typescript/`
- `technologies/typescript/react/`
- `technologies/typescript/react/moritzbrantner-ui/`
- `technologies/tooling/` plus `vite/`, `vitest/`, and `playwright/`

Repository-local rules below override only where they conflict.

## Repository-specific rules

- Treat Subtitle Merger as the vertical consumer: upstream Native WhisperX or audio-stack work must be driven by a concrete editor or subtitle workflow.
- Read `docs/adr/0003-released-native-whisperx-boundary.md` before changing transcription, translation, or their source dependency boundary.
- Host-native development is canonical because the product uses native file picking, local media/model caches, and optional local GPU resources. Containers are optional verification tools, not the source of truth for the development environment.
- Keep the development loop usable directly from the repository. GitHub issues and the agent-loop are optional orchestration adapters, not prerequisites for implementation.

## Repository context

- Domain vocabulary: `CONTEXT.md`
- Architectural decisions: `docs/adr/`
- Optional GitHub/orchestrator workflow: `docs/agents/`
