import type { ParsedSubtitle, VideoInspection } from "./types";

type WasmExports = {
  memory: WebAssembly.Memory;
  allocate: (len: number) => number;
  deallocate: (ptr: number, len: number) => void;
  inspect_video: (ptr: number, len: number) => bigint;
  parse_subtitle: (ptr: number, len: number) => bigint;
};

type WasmOperation = "inspect_video" | "parse_subtitle";

let exportsPromise: Promise<WasmExports> | undefined;

function wasmUrl() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return `${basePath}/subtitle_merger_web_wasm.wasm`;
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

async function invoke<T>(operation: WasmOperation, bytes: Uint8Array): Promise<T> {
  const wasm = await loadWasm();
  if (bytes.byteLength > 0xffff_ffff) {
    throw new Error("This file is too large for the current WebAssembly memory interface.");
  }

  const inputPtr = wasm.allocate(bytes.byteLength);
  if (bytes.byteLength > 0 && inputPtr === 0) {
    throw new Error("WebAssembly could not allocate memory for this file.");
  }

  try {
    new Uint8Array(wasm.memory.buffer, inputPtr, bytes.byteLength).set(bytes);
    const packed = wasm[operation](inputPtr, bytes.byteLength);
    const outputPtr = Number(packed & 0xffff_ffffn);
    const outputLen = Number(packed >> 32n);
    if (outputLen === 0) {
      throw new Error("Rust returned an empty response.");
    }
    const jsonBytes = new Uint8Array(wasm.memory.buffer, outputPtr, outputLen);
    const json = new TextDecoder().decode(jsonBytes);
    wasm.deallocate(outputPtr, outputLen);
    return JSON.parse(json) as T;
  } finally {
    wasm.deallocate(inputPtr, bytes.byteLength);
  }
}

export async function inspectVideo(file: File): Promise<VideoInspection> {
  return invoke<VideoInspection>("inspect_video", new Uint8Array(await file.arrayBuffer()));
}

export async function parseSubtitle(file: File): Promise<ParsedSubtitle> {
  return invoke<ParsedSubtitle>("parse_subtitle", new Uint8Array(await file.arrayBuffer()));
}
