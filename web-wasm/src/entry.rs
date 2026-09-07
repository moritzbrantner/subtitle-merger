include!("lib.rs");
// Rich source-document semantics stay Rust-owned so later editing can reserialize without reparsing in JavaScript.
mod document;
// Deterministic track ordering, timing transforms, overlap handling, and merged serialization are Rust-owned.
mod merge;
mod range_inspection;
