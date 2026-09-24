# Subtitle Merger

Rust backend and React + TypeScript editor for loading video/subtitle siblings, generating subtitles with Native WhisperX, editing them on a timeline, and exporting the edited result. The repository also ships a static Next.js GitHub Pages surface that keeps selected media browser-local, uses Rust compiled to WebAssembly for subtitle parsing and embedded-track extraction, and can generate a timed source subtitle track with the same reusable WebGPU transcription capability consumed by Native WhisperX's browser surface.

## Start the local application

From a checkout, with **Bun 1.3.14, Git, Rust/Cargo and the platform's native build toolchain** installed:

```sh
bun start
```

This installs the pinned frontend dependencies, reuses working FFmpeg/ffprobe from PATH or downloads an app-local pair, builds/starts the backend, waits for its health endpoint, and opens the editor. Both processes stop together on Ctrl+C or a startup failure. No administrator access, Python environment, model CLI, account token, or manual model download is required for the standard transcription/translation workflow. This is a source launcher, not a packaged application: Rust and native build prerequisites still need to be installed once.

Open a video and click **Generate subtitles**. Native WhisperX resolves the models it needs and downloads missing ones automatically: the existing `small` ASR model, the configured alignment model, and only the requested translation language route when translation is selected. Model resolution, downloading and loading appear as distinct status messages. Downloads may be large and require internet access, a writable cache and free disk space. Subsequent runs reuse cached model artifacts; simply opening/editing subtitles does not download AI models.

The model cache defaults to the OS cache directory under `subtitle-merger/models`; the generation panel displays its exact location. Set `SUBTITLE_MODEL_CACHE_DIR` to override it. ASR, alignment and translation use this same root. Downloads and inference remain owned by Native WhisperX; the editor does not implement a second model cache or downloader. Failure messages retain the native cause, release the generation controls for retry, and preserve source subtitles if only translation fails.

The local editor submits the opened video's opaque media ID when generating. It does not fetch the entire local video into the browser and upload it back to the same backend. The legacy multipart upload API remains available for small external clients; its existing extractor limits are not the large-file path.

**Speaker identification is not compiled into the current Native WhisperX feature set.** Its checkbox is disabled with an explanation, and the backend rejects unsupported requests before starting a job. The static GitHub Pages app can generate a transcription-only source track through the pinned browser WebGPU adapter also consumed by Native WhisperX. Browser generation has no server, Python, or CPU fallback; use `bun start` for alignment, translation, and the full host-native generation workflow.

### Startup options and troubleshooting

- `SERVER_ADDR=127.0.0.1:3000` changes the backend address; the launcher wires the frontend proxy to it. The launcher accepts loopback only because this API accesses local files.
- `SUBTITLE_OPEN_BROWSER=0` starts without opening a browser.
- `SUBTITLE_TOOLS_CACHE_DIR` overrides the FFmpeg tool cache; `SUBTITLE_AUTO_DOWNLOAD_TOOLS=0` disables missing-tool downloads while still allowing installed/cached tools.

Automatic FFmpeg setup supports Windows x64, Linux x64/arm64 and macOS x64/arm64. Other platforms need working `ffmpeg` and `ffprobe` on PATH. Working system tools always take precedence. The fallback uses the fixed `descriptinc/ffmpeg-ffprobe-static` release `b6.1.2-rc.1`, pinned GitHub asset IDs and expected sizes, with provenance retained in `SOURCE.json`. It verifies both executables before publishing the staged cache directory; interrupted downloads are discarded and retried on the next start. These checks are not cryptographic checksum verification. The release source/build and licensing information is linked in `scripts/runtime-tools.mjs` and the cache provenance.

For a failed download, fix the reported network, permissions or disk-space issue and retry. Do not delete a complete cache merely to retry a failed job. For a missing backend/tool error, restart with `bun start`. An occupied backend port or native build failure is reported in the launcher terminal instead of leaving an apparently ready editor. A dropped progress stream falls back to repeated job polling; a vanished job after a backend restart produces a retry message.

## Project layout

```text
backend/    Rust API service and generation integration
frontend/   React + TypeScript Vite editor
site/       Static Next.js GitHub Pages application
web-wasm/   Dependency-free Rust browser core compiled to WebAssembly
e2e/        Browser acceptance workflows
docs/       ADRs and optional agent/orchestrator metadata
```

## Development

The split development loop remains available after installing dependencies and making FFmpeg/ffprobe available on PATH:

```sh
bun install
cargo fetch --manifest-path backend/Cargo.toml
bun run dev:backend
```

Run the frontend in another terminal:

```sh
bun run dev:frontend
```

The frontend runs at `http://localhost:5173` and proxies `/api/*` requests to the backend at `http://127.0.0.1:3000` by default. The launcher supplies `VITE_BACKEND_URL` for a custom backend port. Copy `.env.example` to `.env` only when overriding defaults; `bun start` loads Bun's environment files.

Host-native development is intentional because the application uses a native file picker, local media/model caches, and may use local GPU resources. Containers are optional verification tools rather than the canonical development topology.

### Static browser site

The static `site/` application has its own dependency install. Install the browser target once, then build the Rust WebAssembly asset and start Next.js:

```sh
bun install --cwd site
rustup target add wasm32-unknown-unknown
bun run build:web-wasm
bun run prepare:browser-transcription
bun run --cwd site dev
```

The static site accepts one Reference Video plus multiple SRT, WebVTT, ASS, or SSA files. It can also generate a timed source Subtitle Track from the Reference Video when WebGPU and browser media decoding are available. The generation path pins the same `audio-analysis-transcription-wasm` browser capability currently consumed by Native WhisperX, while Rust/WASM remains authoritative for subtitle serialization, parsing, editing, merging, and embedded-track extraction. Supported embedded text codecs are extracted into ordinary browser-local Subtitle Tracks; bitmap codecs such as PGS and VobSub are reported explicitly rather than silently ignored.

The browser transcription adapter downloads its Whisper model assets on first use and reuses the browser cache afterward. It has no application-server, Python, or CPU inference fallback. The selected Reference Video remains attached to its file input while it is in use so browsers and mobile file providers retain access to the selected bytes. Direct Blob decoding remains the normal fast path. If the browser reports that the selected file can no longer be read or allocated as one whole buffer, Subtitle Merger falls back to the adapter's bounded MediaStream session by playing the same local media silently and streaming decoded audio at media playback speed. ASR, PCM windowing, backpressure, and resampling remain owned by `audio-analysis`. Alignment, diarization, translation, and broader Native WhisperX Workflow Composition are intentionally not approximated on the Pages surface.

Uploaded subtitle files retain their source document in the browser. Cue timing and source-text edits are applied by Rust and reserialized through the lossless subtitle document model before the browser replaces the track, preserving supported SRT identifiers/settings, WebVTT metadata blocks/settings, and ASS/SSA script/style/event metadata. Failed edits leave the previous document intact. Embedded tracks remain read-only until their extracted rich source document is retained by a later slice.

No application API is called by the Pages build and there is no upload fallback: the selected media bytes remain in the browser. Video inspection runs in a Web Worker through a Rust-owned pull protocol. The browser services only exact `File.slice()` ranges requested by Rust, so large media payloads are not copied wholesale into WebAssembly memory. MP4 metadata reads are capped at 64 MiB, coalesced subtitle-sample reads at 4 MiB, and Matroska subtitle-block reads at 16 MiB.

Build the exact static export used by GitHub Pages with:

```sh
bun run build:web-wasm
bun run prepare:browser-transcription
bun run --cwd site build
node scripts/check-pages.mjs
```

## Validation

The canonical broad application gate is:

```sh
bun run check
```

It runs deterministic startup/download tests, frontend lint and unit tests, builds the frontend, checks and tests the Rust backend, and tests the dependency-free browser Rust core. CI also verifies that the root `Cargo.lock` does not drift.

Focused commands include:

```sh
bun run test:startup
bun run --cwd frontend test
bun run test:backend
bun run test:web-wasm
bun run build
```

Startup tests use injected tool downloads and temporary caches; they cover cold setup, cache reuse with downloads disabled, partial cleanup, retry and invalid responses without downloading large binaries in ordinary CI. Generation tests cover automatic-download configuration, retained/replayed progress, terminal state, polling recovery, failure/retry and registered media IDs. Browser acceptance simulates model lifecycle events rather than downloading real AI models. These tests do not substitute for a real cold-cache native inference run on a supported host.

The `Pages` workflow separately compiles `web-wasm/` to `wasm32-unknown-unknown`, prepares and contract-checks the exact pinned browser transcription adapter, runs the Pages helper tests, typechecks and statically exports `site/`, verifies the generated assets, and deploys only from `main`.

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
