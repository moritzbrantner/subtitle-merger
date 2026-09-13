include!("lib.rs");
// Rich source-document semantics stay Rust-owned so later editing can reserialize without reparsing in JavaScript.
mod document;
// Cue edits reserialize through the rich Rust document so source-format metadata stays intact.
mod edit;
// Preserve source metadata ordering while splicing Rust-serialized cue edits back into the document.
mod source_rewrite;
// Deterministic track ordering, timing transforms, overlap handling, and merged serialization are Rust-owned.
mod merge;
mod range_inspection;
