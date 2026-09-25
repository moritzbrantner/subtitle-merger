import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const audioAnalysisRevision = "02999d787cd9c3eb8d88280b0ffb99b4e196161c";
const audioAnalysisRepository = "https://github.com/moritzbrantner/audio-analysis.git";
const sourcePath = "packages/audio-analysis-transcription-wasm/index.js";
const publicDirectory = resolve(repositoryRoot, "site", "public");
const vendorDirectory = resolve(publicDirectory, "vendor");
const runtimeTarget = resolve(vendorDirectory, "audio-analysis-transcription.js");
const bridgeTarget = resolve(publicDirectory, "browser-transcription-bridge.js");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

const worktree = await mkdtemp(join(tmpdir(), "subtitle-merger-browser-transcription-"));

try {
  git(["init", "-q"], worktree);
  git(["fetch", "--quiet", "--depth=1", audioAnalysisRepository, audioAnalysisRevision], worktree);
  git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], worktree);

  const runtime = await readFile(resolve(worktree, sourcePath), "utf8");
  const requiredContract = [
    "export function browserTranscriptionModels()",
    "export function browserTranscriptionCapabilities()",
    "export async function supportsBrowserTranscription()",
    "export async function transcribeAudioBlob",
    "export function createBrowserDecodedAudioTranscriptionSession",
    "export function createBrowserPcmResampler",
    '"WebCodecs AudioData stream"',
    "decodedAudioAdapter: true",
    'id: "onnx-community/whisper-tiny"',
    'id: "onnx-community/whisper-base"',
    'id: "onnx-community/whisper-small"',
    "models: browserTranscriptionModels()",
    "maxIdleResidentModels: 1",
    'eviction: "dispose-superseded"',
    'requiredAcceleration: "webgpu"',
    "translation: false",
    "server: false",
    "python: false",
    "cpu: false",
  ];
  for (const required of requiredContract) {
    if (!runtime.includes(required)) {
      throw new Error(`Pinned browser transcription source is missing required contract marker: ${required}`);
    }
  }

  await mkdir(vendorDirectory, { recursive: true });
  await writeFile(runtimeTarget, runtime);
  await writeFile(
    bridgeTarget,
    [
      'import * as runtime from "./vendor/audio-analysis-transcription.js";',
      "globalThis.__subtitleMergerBrowserTranscription = runtime;",
      "",
    ].join("\n"),
  );

  console.log(
    `Prepared the selectable finite-file Whisper browser transcription runtime from audio-analysis ${audioAnalysisRevision}.`,
  );
} finally {
  await rm(worktree, { recursive: true, force: true });
}
