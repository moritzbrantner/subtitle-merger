include!("lib.rs");
// Rich source-document semantics stay Rust-owned so later editing can reserialize without reparsing in JavaScript.
mod document;
// Cue edits reserialize through the rich Rust document so source-format metadata stays intact.
mod edit;
// Preserve source metadata ordering while splicing Rust-serialized cue edits back into the document.
mod source_rewrite;
// Structural split/merge operations remain Rust-owned and fail closed on metadata loss.
mod structure;
// Two-anchor subtitle drift correction remains Rust-owned and rewrites accepted source documents losslessly.
mod drift;
// Deterministic read-only subtitle quality diagnostics stay Rust-owned and never rewrite source content.
mod quality;
// Deterministic track ordering, timing transforms, overlap handling, and merged serialization are Rust-owned.
mod merge;
mod range_inspection;
