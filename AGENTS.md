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
- Keep the development loop usable directly from the repository.

## Authority boundaries

Machine-readable in `.repository.toml` (`[architecture]`); keep both lists identical. `bun run check:boundaries` rejects direct ASR/alignment/translation/model-runtime dependencies in the editor manifests.

- Owns: `subtitle-merger/subtitle-editing`, `subtitle-merger/timeline-workflow`, `subtitle-merger/generation-ux`, `subtitle-merger/subtitle-export`, `subtitle-merger/local-app-bootstrap`
- Adapts: `native-whisperx/transcription`, `native-whisperx/alignment`, `native-whisperx/translation`, `audio-analysis/browser-transcription`, `timeline-editor/timeline-ui`, `editor-core/editor-model`
- Non-authoritative: `native-whisperx/transcription`, `native-whisperx/alignment`, `native-whisperx/translation`, `audio-analysis/browser-transcription`, `media/model-runtime`

## Repository context

- Domain vocabulary: `CONTEXT.md`
- Architectural decisions: `docs/adr/`
- Domain context: `docs/agents/domain.md`
