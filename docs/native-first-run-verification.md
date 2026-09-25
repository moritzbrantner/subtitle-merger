# Real native first-run verification

This is an explicit external-network acceptance tier, not part of `bun run check`.
It runs the actual `bun start` launcher and Chromium editor with a newly created
application model cache and isolated Hugging Face home. Model responses, job APIs,
media loading and subtitle export are not mocked. The human speech fixture is the
short JFK sample from whisper.cpp v1.7.6; its bytes are checked against the retained
Git blob identity before it is put into a video using the downloaded FFmpeg.

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun e2e/native-first-run.mjs
```

Bun, Git, Cargo/Rust and native build tools must be available, just as for the source
launcher. This downloads real FFmpeg binaries and ASR/alignment/translation models;
it needs internet, memory and disk space. The launcher uses its documented frontend
port 5173, so stop another local editor before running. The backend gets a disposable
OS-assigned port. No smaller ASR model or preconfigured alignment bypass is substituted.
Alignment is attempted with the normal application configuration. If the native aligner
hits the observed content-specific `CTC path is impossible` mismatch, the application
retries ASR without word alignment so a usable transcript is not lost; setup/cache
alignment errors remain fatal and are not covered by that fallback.

Normal `bun start` builds/runs the optimized Cargo release profile for CPU inference.
The first optimized build is slower than a debug build, but later launches reuse it.
Use the separate `bun run dev:backend` command when a debug backend is needed. The
real first-run test previously spent its entire 15-minute inference allowance in
unoptimized transcription of this short speech clip; that failed run is not counted
as a pass or hidden by changing the model, audio, alignment or inference timeout.
The verifier checks that the launcher actually executes the release binary.

The test checks a cold source transcription, a newly requested English-to-German
translation, and a complete launcher/backend restart with the same on-disk models.
The restart sets `SUBTITLE_MODEL_CACHE_ONLY=1`, points `HF_HOME` at a new empty
directory, and sets `HF_HUB_OFFLINE=1`; a successful warm run therefore cannot
silently fetch replacement model artifacts or reuse a hidden Hugging Face cache.
It rejects failed jobs, empty or unrelated transcripts, invalid cue times, missing
translation and unusable subtitle exports. Both source and translation are selected
and exported separately. Shutdown must close both server ports and the restarted
backend must have a fresh job registry, preventing accidental reuse of a live model.
The restarted run must leave model bytes, digests and modification times unchanged.
This proves persistent artifact reuse, not complete network isolation or universal
language coverage. Native WhisperX's current DownloadStart event wraps a resolver
that also serves disk-cache hits; phase history is not a network-transfer counter.

The `Native First Run` workflow can be launched manually. It also runs when a PR
changes this verifier or its workflow, not on every ordinary application PR. Build
artifacts may be cached; AI/tool caches always start empty. Evidence is retained in
`.artifacts/first-run/` and the workflow artifact, including actual transcripts,
exported SRT, model file sizes/digests, phases, launch logs and editor screenshots.
Results are published only after execution; adding the test is not a passing result.

## Regressions discovered at real application boundaries

`bun e2e/dev-startup.mjs` checks the actual Vite development server after a plain
locked install, with no editor-family source overrides. It requires Chromium but
no native backend or models. This exposed a blank-page ESM linking failure that
production-build acceptance could not catch: the UI chain imported the CommonJS
`use-sync-external-store` shims without prebundling. Vite now explicitly prebundles
the two shim entry points while retaining Timeline Editor source aliases. Browser
exception details and screenshots are retained on failure.

Once the editor started, the first real job exposed an invalid native configuration:
`output.formats` was cleared to suppress file writes, but Native WhisperX requires a
format even with no output directory. The backend now retains JSON format and sets
`output_dir=None`, which is the native API's no-file-write mode. Hermetic regression
tests call the real request validator and writer, including a reproduction of the
old rejected configuration, rather than merely asserting application field values.
