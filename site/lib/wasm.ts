import type { ParsedSubtitle, Track, VideoInspection } from "./types";

type WasmExports = {
  memory: WebAssembly.Memory;
  allocate: (len: number) => number;
  deallocate: (ptr: number, len: number) => void;
  parse_subtitle_document: (ptr: number, len: number) => bigint;
  merge_tracks: (ptr: number, len: number, format: number) => bigint;
};

export type VideoInspectionProgress = {
  phase: string;
  transferred: number;
  fileSize: number;
};

export type MergeFormat = "ass" | "srt" | "vtt";

export type MergeResult = {
  content: string;
  extension: string;
  mimeType: string;
};

type MergePayload = Partial<MergeResult> & { error?: string };

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

function decodePackedJson<T>(wasm: WasmExports, packed: bigint): T {
  const outputPtr = Number(packed & 0xffff_ffffn);
  const outputLen = Number(packed >> 32n);
  if (outputLen === 0) {
    throw new Error("Rust returned an empty response.");
  }
  try {
    const jsonBytes = new Uint8Array(wasm.memory.buffer, outputPtr, outputLen);
    return JSON.parse(new TextDecoder().decode(jsonBytes)) as T;
  } finally {
    wasm.deallocate(outputPtr, outputLen);
  }
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
    return decodePackedJson<ParsedSubtitle>(
      wasm,
      wasm.parse_subtitle_document(inputPtr, bytes.byteLength),
    );
  } finally {
    wasm.deallocate(inputPtr, bytes.byteLength);
  }
}

function encodeMergeTracks(tracks: Track[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = tracks.map((track) => ({
    track,
    title: encoder.encode(track.title),
    cues: track.cues.map((cue) => ({ cue, text: encoder.encode(cue.text) })),
  }));
  let length = 4;
  for (const item of prepared) {
    length += 8 + 4 + item.title.byteLength + 4;
    for (const cue of item.cues) {
      length += 8 + 8 + 4 + cue.text.byteLength;
    }
  }
  if (length > 0xffff_ffff) {
    throw new Error("The selected subtitle tracks are too large for one merge request.");
  }

  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const u64 = (value: number) => {
    view.setBigUint64(offset, BigInt(Math.max(0, Math.round(value))), true);
    offset += 8;
  };
  const i64 = (value: number) => {
    view.setBigInt64(offset, BigInt(Math.trunc(value)), true);
    offset += 8;
  };
  const buffer = (value: Uint8Array) => {
    u32(value.byteLength);
    bytes.set(value, offset);
    offset += value.byteLength;
  };

  u32(prepared.length);
  for (const item of prepared) {
    i64(item.track.offsetMs);
    buffer(item.title);
    u32(item.cues.length);
    for (const itemCue of item.cues) {
      u64(itemCue.cue.startMs);
      u64(itemCue.cue.endMs);
      buffer(itemCue.text);
    }
  }
  return bytes;
}

function mergeFormatCode(format: MergeFormat) {
  switch (format) {
    case "ass":
      return 1;
    case "srt":
      return 2;
    case "vtt":
      return 3;
  }
}

export async function mergeTracks(tracks: Track[], format: MergeFormat): Promise<MergeResult> {
  const selected = tracks.filter((track) => track.enabled);
  if (selected.length === 0) {
    throw new Error("Enable at least one subtitle track before merging.");
  }
  const bytes = encodeMergeTracks(selected);
  const wasm = await loadWasm();
  const inputPtr = wasm.allocate(bytes.byteLength);
  if (bytes.byteLength > 0 && inputPtr === 0) {
    throw new Error("WebAssembly could not allocate memory for the merge request.");
  }
  try {
    new Uint8Array(wasm.memory.buffer, inputPtr, bytes.byteLength).set(bytes);
    const payload = decodePackedJson<MergePayload>(
      wasm,
      wasm.merge_tracks(inputPtr, bytes.byteLength, mergeFormatCode(format)),
    );
    if (payload.error) {
      throw new Error(payload.error);
    }
    if (!payload.content || !payload.extension || !payload.mimeType) {
      throw new Error("Rust returned an incomplete merge result.");
    }
    return {
      content: payload.content,
      extension: payload.extension,
      mimeType: payload.mimeType,
    };
  } finally {
    wasm.deallocate(inputPtr, bytes.byteLength);
  }
}

export async function inspectVideo(
  file: File,
  onProgress?: (progress: VideoInspectionProgress) => void,
  signal?: AbortSignal,
): Promise<VideoInspection> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`${basePath()}/video-inspection-worker.js`);
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      if (settled) {
        return;
      }
      finish();
      reject(new DOMException("Video inspection was cancelled.", "AbortError"));
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });

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
