# ADR 0004: Static browser Pages boundary

## Status

Accepted — 2026-09-07

## Context

Subtitle Merger has a host-native application whose backend owns local file-path loading and Native WhisperX generation workflows. GitHub Pages cannot provide those host-native capabilities, but it can provide a useful analyzer/editor slice for explicitly selected browser files.

The hosted surface must not weaken the existing Native WhisperX boundary or turn GitHub Pages into an upload service. It also needs reusable Rust authority for subtitle parsing and embedded-track extraction rather than a second JavaScript-only implementation.

## Decision

Add `site/` as a separate statically exported Next.js application and `web-wasm/` as a dependency-free Rust browser core compiled directly to `wasm32-unknown-unknown`.

The Pages surface:

- accepts exactly one Reference Video and zero or more explicitly selected subtitle files;
- keeps every selected byte in the browser and has no application-server or upload fallback;
- uses Rust/WASM to parse SRT, WebVTT, ASS, and SSA files;
- uses Rust/WASM to inspect MP4/MOV and Matroska/WebM containers and extract supported embedded text subtitle tracks;
- reports unsupported embedded bitmap/non-text subtitle tracks rather than dropping them silently;
- projects Rust-owned cue timing/text into React for preview, timeline navigation, and SRT/WebVTT downloads;
- remains separate from Native WhisperX transcription and translation, which continue to require the native/backend boundary documented in ADR 0003.

The first WASM ABI intentionally has no third-party Rust dependencies. It exchanges UTF-8 JSON across an explicit allocate/call/deallocate boundary so the static build does not need `wasm-bindgen` tooling or change the root Cargo lockfile.

## Consequences

The current implementation reads the entire selected video into WebAssembly memory. This keeps ownership simple and serverless but makes memory use proportional to input size. Streaming/random-access browser file inspection is a future optimization and must preserve the same Rust authority and browser-local privacy boundary.

Embedded extraction is text-first. MP4 tx3g/wvtt/stpp and Matroska UTF-8/WebVTT/ASS/SSA/USF are decoded; bitmap formats such as PGS and VobSub remain visible as unsupported tracks until an explicit OCR/rendering slice owns them.

The existing Vite/native application remains intact and continues to be the canonical surface for host-native generation workflows.
