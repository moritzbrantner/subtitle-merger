import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "site", "out");
const indexPath = resolve(out, "index.html");
const wasmPath = resolve(out, "subtitle_merger_web_wasm.wasm");
const transcriptionPath = resolve(out, "vendor", "audio-analysis-transcription.js");
const bridgePath = resolve(out, "browser-transcription-bridge.js");

for (const path of [indexPath, wasmPath, transcriptionPath, bridgePath]) {
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

const wasm = await stat(wasmPath);
if (wasm.size < 1000) {
  throw new Error("Rust WebAssembly asset is unexpectedly small.");
}
console.log(`Verified static Pages export (${wasm.size} byte WASM asset plus selectable finite-file Whisper transcription runtime).`);
