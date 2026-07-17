# Subtitle Merger

Rust backend and React frontend scaffold for the subtitle merger application.

## Project Layout

```text
backend/   Rust API service
frontend/  React + TypeScript Vite app
```

## Prerequisites

- Rust toolchain with Cargo
- [Bun](https://bun.sh/) 1.3.14

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

The frontend runs at `http://localhost:5173` and proxies `/api/*` requests to
the backend at `http://127.0.0.1:3000`.

## Checks

```sh
bun run check
```

This builds the frontend, checks the Rust backend, and runs backend tests.

## End-to-end tests

The E2E suite imports and plays a real MP4 through the File menu in Chromium.
Install Chromium for Playwright once:

```sh
bunx playwright install chromium
```

The suite requires `yt-dlp`. On its first run it downloads and caches the
specified YouTube video in `e2e/fixtures/`; the video is ignored by Git and
reused by subsequent runs.

```sh
bun run test:e2e
```
