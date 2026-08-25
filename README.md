# Subtitle Merger

Rust backend and React + TypeScript editor for loading video/subtitle siblings, generating subtitles with Native WhisperX, editing them on a timeline, and exporting the edited result.

## Project layout

```text
backend/   Rust API service and generation integration
frontend/  React + TypeScript Vite editor
e2e/       Browser acceptance workflows
docs/      ADRs and optional agent/orchestrator metadata
```

## Prerequisites

- Rust toolchain with Cargo
- Bun 1.3.14
- FFmpeg/ffprobe for generated subtitles
- Playwright Chromium and `yt-dlp` only for the real-media E2E suite

Copy `.env.example` to `.env` only when overriding the documented backend defaults.

## Install

```sh
bun install
cargo fetch --manifest-path backend/Cargo.toml
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

## Validation

The canonical broad application gate is:

```sh
bun run check
```

It runs frontend lint and unit tests, builds the frontend, checks and tests the Rust backend, and is the same application check used in CI. CI also verifies that `Cargo.lock` does not drift.

Focused commands include:

```sh
bun run --cwd frontend test
bun run test:backend
bun run build
```

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
