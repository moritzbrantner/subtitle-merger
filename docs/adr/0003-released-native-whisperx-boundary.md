# Native WhisperX dependency boundary

Subtitle Merger uses two explicit dependency modes.

## Development mode

Ordinary feature development may consume Native WhisperX and its required audio capability packages from exact source revisions declared in `.coding-tooling.source-deps.json`. This allows Subtitle Merger to drive Native WhisperX and audio-stack changes without publishing intermediate crates.

The source graph must be exact and reproducible. Local sibling checkouts are accepted only when they match the declared revisions. The generated Cargo patch configuration is local development state and is not release evidence.

## Release mode

A distributable Subtitle Merger release consumes Native WhisperX through a pinned published Cargo release. Registry-only resolution must be proven from a clean checkout after source overrides are deactivated.

Multi-language translation and other Native WhisperX capabilities are enabled according to the selected source revision during development and the selected published release during distribution. Publication is therefore a release concern, not a prerequisite for implementing or validating application behavior.
