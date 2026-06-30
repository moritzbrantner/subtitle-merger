# Subtitle Merger

Rust backend and React frontend scaffold for the subtitle merger application.

## Project Layout

```text
backend/   Rust API service
frontend/  React + TypeScript Vite app
```

## Prerequisites

- Rust toolchain with Cargo
- Node.js with npm

## Install

```sh
npm install
cargo fetch --manifest-path backend/Cargo.toml
```

## Development

Run the backend API:

```sh
npm run dev:backend
```

Run the frontend in another terminal:

```sh
npm run dev:frontend
```

The frontend runs at `http://localhost:5173` and proxies `/api/*` requests to
the backend at `http://127.0.0.1:3000`.

## Checks

```sh
npm run check
```

This builds the frontend, checks the Rust backend, and runs backend tests.
