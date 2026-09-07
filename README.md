# Subtitle Merger

Rust backend and React + TypeScript editor for loading video/subtitle siblings, generating subtitles with Native WhisperX, editing them on a timeline, and exporting the edited result. The repository also ships a static Next.js GitHub Pages surface that keeps uploaded media browser-local and uses Rust compiled to WebAssembly for subtitle parsing and embedded-track extraction.

## Project layout

```text
backend/    Rust API service and generation integration
frontend/   React + TypeScript Vite editor
site/       Static Next.js GitHub Pages application
web-wasm/   Dependency-free Rust browser core compiled to WebAssembly
e2e/        Browser acceptance workflows
docs/       ADRs and optional agent/orchestrator metadata
```

## Prerequisites

- Rust toolchain with Cargo
- Bun 1.3.14
- FFmpeg/ffprobe for generated subtitles
- Playwright Chromium and `yt-dlp` only for the real-media E2E suite
- `wasm32-unknown-unknown` Rust target when building the static site locally

Copy `.env.example` to `.env` only when overriding the documented backend defaults.

## Install

```sh
bun install
cargo fetch --manifest-path backend/Cargo.toml
```

The static `site/` application intentionally has its own dependency install so the existing Vite editor lockfile and workspace remain unchanged:

```sh
cd site
bun install
```

## Development

Run the backend API:

```sh
bun run dev:backend
```

Run the frontend in another terminal:

```sh
bun run dev:frontend
```

The frontend runs at `http://localhost:5173` and proxies `/api/*` requests to the backend at `http://127.0.0.1:3000` by default.

Host-native development is intentional because the application uses a native file picker, local media/model caches, and may use local GPU resources. Containers are optional verification tools rather than the canonical development topology.

### Static browser site

Install the browser target once, then build the Rust WebAssembly asset and start Next.js:

```sh
rustup target add wasm32-unknown-unknown
bun run build:web-wasm
bun run --cwd site dev
```

The static site accepts one Reference Video plus multiple SRT, WebVTT, ASS, or SSA files. The Rust/WASM boundary parses uploaded subtitle files and inspects MP4/MOV and Matroska/WebM containers for embedded text subtitle tracks. Supported embedded text codecs are extracted into ordinary browser-local Subtitle Tracks; bitmap codecs such as PGS and VobSub are reported explicitly rather than silently ignored.

No application API is called by the Pages build and there is no upload fallback: the selected media bytes remain in the browser. The first implementation reads the selected video into WebAssembly memory, so large files require browser memory proportional to file size.

Build the exact static export used by GitHub Pages with:

```sh
bun run build:web-wasm
bun run --cwd site build
node scripts/check-pages.mjs
```

## Validation

The canonical broad application gate is:

```sh
bun run check
```

It runs frontend lint and unit tests, builds the frontend, checks and tests the Rust backend, and tests the dependency-free browser Rust core. CI also verifies that the root `Cargo.lock` does not drift.

Focused commands include:

```sh
bun run --cwd frontend test
bun run test:backend
bun run test:web-wasm
bun run build
```

The `Pages` workflow separately compiles `web-wasm/` to `wasm32-unknown-unknown`, typechecks and statically exports `site/`, verifies the generated WASM asset, and deploys only from `main`.

## End-to-end tests

The E2E suite exercises user-visible video and timeline workflows in Chromium and retains Playwright failure evidence.

Install Chromium once:

```sh
bunx playwright install chromium
```

The current real-media fixture requires `yt-dlp`. On first run it downloads and caches the configured video under `e2e/fixtures/`; the media file is ignored by Git and reused subsequently.

```sh
bun run test:e2e
```

## Dependency development

Ordinary application work is source-first. See `docs/adr/0003-released-native-whisperx-boundary.md` for the Native WhisperX development/release boundary. Package publication is not required to prove feature work.

The frontend pins Timeline Editor to an exact Git revision and resolves the Timeline Editor entry points it consumes directly from that revision's `src/` tree. Its transitive dependencies continue to use their normal package exports. Update the pin only when a concrete Subtitle Merger workflow requires reviewed upstream behavior; do not patch compiled `node_modules` output.
