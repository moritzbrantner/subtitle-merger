# Native WhisperX dependency boundary

Subtitle Merger uses two explicit dependency modes.

## Development mode

Ordinary feature development consumes Native WhisperX from an exact Git revision in the backend manifest. This gives a clean checkout the same unreleased Native WhisperX source in local development and validation without publishing an intermediate crate.

The Git dependency keeps the declared `0.1.14` version requirement as an additional compatibility check. Update the immutable revision only after the selected Native WhisperX source has been reviewed for the Subtitle Merger workflow.

`.coding-tooling.source-deps.json` is reserved for additional transitive source overrides when a specific cross-repository task genuinely needs them. It is empty by default. Native WhisperX owns its own audio source-development closure, so Subtitle Merger does not automatically patch the entire audio repository for ordinary application work.

The source graph must remain exact and reproducible. Source-mode evidence is implementation evidence, not release evidence.

## Release mode

A distributable Subtitle Merger release switches Native WhisperX back to a pinned published Cargo release. Registry-only resolution must be proven from a clean checkout with no source overrides.

Multi-language translation and other Native WhisperX capabilities are enabled according to the selected source revision during development and the selected published release during distribution. Publication is therefore a release concern, not a prerequisite for implementing or validating application behavior.
