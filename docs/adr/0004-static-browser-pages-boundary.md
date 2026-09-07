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

The Rust browser core intentionally has no third-party dependencies. Small subtitle files use the explicit allocate/call/deallocate ABI and exchange UTF-8 JSON. Reference-video inspection uses a stateful Rust-owned pull protocol instead: Rust exposes the next exact byte range it needs, a dedicated browser Web Worker services that request with `File.slice()`, and the bytes are supplied back to the same Rust inspection session. JavaScript does not infer container structure or choose media ranges.

For bounded browser memory and deterministic failure behavior:

- initial container detection reads 32 bytes;
- MP4/MOV top-level box headers are scanned without reading skipped media payloads;
- a complete MP4 `moov` metadata range may be read up to 64 MiB;
- nearby MP4 subtitle samples are coalesced into reads of at most 4 MiB;
- Matroska/WebM element headers are scanned incrementally and text-subtitle blocks are read up to 16 MiB;
- starting a newer Reference Video inspection or unmounting the workbench cancels the superseded Worker/session.

## Consequences

Reference-video memory use is no longer proportional to the full media file. Large video payloads remain browser-local `File` data and are copied into WebAssembly only for bounded metadata or subtitle ranges requested by Rust. Container scanning can therefore handle multi-gigabyte media without requiring a same-sized WebAssembly allocation, subject to the explicit per-range bounds above.

Embedded extraction is text-first. MP4 tx3g/wvtt/stpp and Matroska UTF-8/WebVTT/ASS/SSA/USF are decoded; bitmap formats such as PGS and VobSub remain visible as unsupported tracks until an explicit OCR/rendering slice owns them.

The existing Vite/native application remains intact and continues to be the canonical surface for host-native generation workflows.
