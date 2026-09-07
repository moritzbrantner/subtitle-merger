include!("lib.rs");
// Rich source-document semantics stay Rust-owned so later editing can reserialize without reparsing in JavaScript.
mod document;
mod range_inspection;
