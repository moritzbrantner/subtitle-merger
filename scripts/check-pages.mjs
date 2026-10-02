import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "site", "out");
const indexPath = resolve(out, "index.html");
const wasmPath = resolve(out, "subtitle_merger_web_wasm.wasm");
const transcriptionPath = resolve(out, "vendor", "audio-analysis-transcription.js");
const bridgePath = resolve(out, "browser-transcription-bridge.js");
const transcriptionWorkerPath = resolve(out, "audio-transcription-worker.js");

for (const path of [indexPath, wasmPath, transcriptionPath, bridgePath, transcriptionWorkerPath]) {
  await access(path, constants.R_OK);
}

const html = await readFile(indexPath, "utf8");
if (
  !html.includes("Subtitle Merger")
  || !html.includes("browser lab")
  || !html.includes("Generate subtitles")
) {
  throw new Error("Static export does not contain the expected Subtitle Merger browser-generation surface.");
}

const runtime = await readFile(transcriptionPath, "utf8");
for (const required of [
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
  "server: false",
  "python: false",
  "cpu: false",
]) {
  if (!runtime.includes(required)) {
    throw new Error(`Prepared browser transcription runtime is missing: ${required}`);
  }
}

const bridge = await readFile(bridgePath, "utf8");
if (
  !bridge.includes('import * as runtime from "./vendor/audio-analysis-transcription.js"')
  || !bridge.includes("globalThis.__subtitleMergerBrowserTranscription = runtime")
) {
  throw new Error("Browser transcription bridge does not expose the reviewed runtime.");
}


const transcriptionWorker = await readFile(transcriptionWorkerPath, "utf8");
for (const required of [
  "audio_demux_create",
  "audio_demux_poll",
  "audio_demux_supply",
  "audio_demux_acknowledge",
  "AudioDecoder.isConfigSupported",
  "createBrowserDecodedAudioTranscriptionSession",
  "file.slice(offset, end).arrayBuffer()",
]) {
  if (!transcriptionWorker.includes(required)) {
    throw new Error(`Browser transcription worker is missing: ${required}`);
  }
}
if (
  transcriptionWorker.includes("file.arrayBuffer()")
  || transcriptionWorker.includes("captureStream")
  || transcriptionWorker.includes("MediaStream")
) {
  throw new Error("Browser transcription worker regressed to whole-file or real-time media acquisition.");
}

const wasm = await stat(wasmPath);
if (wasm.size < 1000) {
  throw new Error("Rust WebAssembly asset is unexpectedly small.");
}
console.log(`Verified static Pages export (${wasm.size} byte WASM asset plus selectable finite-file Whisper transcription runtime).`);
