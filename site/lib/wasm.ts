import type { ParsedSubtitle, VideoInspection } from "./types";

type WasmExports = {
  memory: WebAssembly.Memory;
  allocate: (len: number) => number;
  deallocate: (ptr: number, len: number) => void;
  parse_subtitle: (ptr: number, len: number) => bigint;
};

export type VideoInspectionProgress = {
  phase: string;
  transferred: number;
  fileSize: number;
};

type WorkerMessage =
  | { type: "result"; inspection: VideoInspection }
  | { type: "error"; message: string }
  | ({ type: "progress" } & VideoInspectionProgress);

let exportsPromise: Promise<WasmExports> | undefined;

function basePath() {
  return process.env.NEXT_PUBLIC_BASE_PATH ?? "";
}

function wasmUrl() {
  return `${basePath()}/subtitle_merger_web_wasm.wasm`;
}

async function loadWasm(): Promise<WasmExports> {
  if (!exportsPromise) {
    exportsPromise = (async () => {
      const response = await fetch(wasmUrl());
      if (!response.ok) {
        throw new Error(`Could not load the Rust WebAssembly module (${response.status}).`);
      }
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports as unknown as WasmExports;
    })();
  }
  return exportsPromise;
}

async function invokeSubtitle(bytes: Uint8Array): Promise<ParsedSubtitle> {
  const wasm = await loadWasm();
  if (bytes.byteLength > 0xffff_ffff) {
    throw new Error("This subtitle file is too large for the current WebAssembly memory interface.");
  }

  const inputPtr = wasm.allocate(bytes.byteLength);
  if (bytes.byteLength > 0 && inputPtr === 0) {
    throw new Error("WebAssembly could not allocate memory for this subtitle file.");
  }

  try {
    new Uint8Array(wasm.memory.buffer, inputPtr, bytes.byteLength).set(bytes);
    const packed = wasm.parse_subtitle(inputPtr, bytes.byteLength);
    const outputPtr = Number(packed & 0xffff_ffffn);
    const outputLen = Number(packed >> 32n);
    if (outputLen === 0) {
      throw new Error("Rust returned an empty response.");
    }
    try {
      const jsonBytes = new Uint8Array(wasm.memory.buffer, outputPtr, outputLen);
      return JSON.parse(new TextDecoder().decode(jsonBytes)) as ParsedSubtitle;
    } finally {
      wasm.deallocate(outputPtr, outputLen);
    }
  } finally {
    wasm.deallocate(inputPtr, bytes.byteLength);
  }
}

export async function inspectVideo(
  file: File,
  onProgress?: (progress: VideoInspectionProgress) => void,
): Promise<VideoInspection> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`${basePath()}/video-inspection-worker.js`);
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "result") {
        finish();
        resolve(message.inspection);
      } else if (message.type === "error") {
        finish();
        reject(new Error(message.message));
      } else if (message.type === "progress") {
        onProgress?.({
          phase: message.phase,
          transferred: message.transferred,
          fileSize: message.fileSize,
        });
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The video inspection worker failed."));
    };
    worker.postMessage({ type: "inspect", file, wasmUrl: wasmUrl() });
  });
}

export async function parseSubtitle(file: File): Promise<ParsedSubtitle> {
  return invokeSubtitle(new Uint8Array(await file.arrayBuffer()));
}