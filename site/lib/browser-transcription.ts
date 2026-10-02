type BrowserTranscriptionProgress = {
  stage?: string;
  message?: string;
  detail?: unknown;
};

export type BrowserTranscriptionModel = {
  id: string;
  label: string;
  description: string;
};

export type BrowserTranscriptionSegment = {
  index?: number;
  startSeconds?: number | null;
  endSeconds?: number | null;
  text?: string | null;
};

export type BrowserTranscriptionResult = {
  text?: string;
  language?: string | null;
  segments?: BrowserTranscriptionSegment[];
  source?: string;
  attributes?: Record<string, unknown>;
};

type BrowserTranscriptionCapabilities = {
  runtime: string;
  requiredAcceleration: string;
  modelId: string;
  models: BrowserTranscriptionModel[];
  modelProvisioning: string;
  features: {
    transcription: boolean;
    timedSegments: boolean;
    boundedPcmStreaming?: boolean;
    decodedAudioAdapter?: boolean;
    mediaStreamAdapter?: boolean;
  };
  fallbacks: {
    server: boolean;
    python: boolean;
    cpu: boolean;
  };
};

type BrowserTranscriptionRuntime = {
  browserTranscriptionCapabilities: () => BrowserTranscriptionCapabilities;
  browserTranscriptionModels: () => BrowserTranscriptionModel[];
  supportsBrowserTranscription: () => Promise<boolean>;
};

type RuntimeWindow = typeof window & {
  __subtitleMergerBrowserTranscription?: BrowserTranscriptionRuntime;
};

export type BrowserTranscriptionSupport =
  | {
      available: true;
      modelId: string;
      models: BrowserTranscriptionModel[];
      runtime: string;
    }
  | {
      available: false;
      reason: string;
    };

let runtimePromise: Promise<BrowserTranscriptionRuntime> | undefined;

function basePath() {
  return process.env.NEXT_PUBLIC_BASE_PATH ?? "";
}

function validateModelCatalog(capabilities: BrowserTranscriptionCapabilities) {
  if (!Array.isArray(capabilities.models) || capabilities.models.length === 0) {
    throw new Error("The browser transcription runtime exposed no selectable models.");
  }

  const ids = new Set<string>();
  const models = capabilities.models.map((model) => {
    if (
      !model
      || typeof model.id !== "string"
      || model.id.trim().length === 0
      || typeof model.label !== "string"
      || model.label.trim().length === 0
      || typeof model.description !== "string"
      || model.description.trim().length === 0
    ) {
      throw new Error("The browser transcription runtime exposed an invalid model catalog.");
    }
    if (ids.has(model.id)) {
      throw new Error(`The browser transcription runtime exposed duplicate model id "${model.id}".`);
    }
    ids.add(model.id);
    return { ...model };
  });

  if (!ids.has(capabilities.modelId)) {
    throw new Error("The browser transcription runtime default model is not present in its catalog.");
  }

  return models;
}

function validateRuntime(runtime: BrowserTranscriptionRuntime | undefined) {
  if (
    !runtime
    || typeof runtime.browserTranscriptionCapabilities !== "function"
    || typeof runtime.browserTranscriptionModels !== "function"
    || typeof runtime.supportsBrowserTranscription !== "function"
  ) {
    throw new Error("The browser transcription runtime did not expose its expected capability surface.");
  }

  const capabilities = runtime.browserTranscriptionCapabilities();
  if (
    capabilities.requiredAcceleration !== "webgpu"
    || capabilities.features.transcription !== true
    || capabilities.features.timedSegments !== true
    || capabilities.features.decodedAudioAdapter !== true
    || capabilities.fallbacks.server !== false
    || capabilities.fallbacks.python !== false
    || capabilities.fallbacks.cpu !== false
  ) {
    throw new Error("The browser transcription runtime no longer matches the reviewed local-only WebGPU contract.");
  }

  validateModelCatalog(capabilities);
  return runtime;
}

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = new Promise<BrowserTranscriptionRuntime>((resolve, reject) => {
      const runtimeWindow = window as RuntimeWindow;
      if (runtimeWindow.__subtitleMergerBrowserTranscription) {
        resolve(validateRuntime(runtimeWindow.__subtitleMergerBrowserTranscription));
        return;
      }

      const script = document.createElement("script");
      script.type = "module";
      script.src = `${basePath()}/browser-transcription-bridge.js`;
      script.dataset.subtitleMergerBrowserTranscription = "true";
      script.onload = () => {
        try {
          resolve(validateRuntime(runtimeWindow.__subtitleMergerBrowserTranscription));
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = () => {
        reject(new Error("The browser transcription runtime could not be loaded."));
      };
      document.head.append(script);
    }).catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  }

  return runtimePromise;
}

function localFileReadError() {
  return new Error(
    "The browser could not read the selected Reference Video for local Whisper transcription. Re-select the Reference Video and retry.",
  );
}

export async function inspectBrowserTranscriptionSupport(): Promise<BrowserTranscriptionSupport> {
  try {
    const runtime = await loadRuntime();
    const capabilities = runtime.browserTranscriptionCapabilities();
    const models = validateModelCatalog(capabilities);
    if (
      typeof AudioDecoder !== "function"
      || typeof EncodedAudioChunk !== "function"
      || typeof Worker !== "function"
    ) {
      return {
        available: false,
        reason: "WebCodecs audio decoding is not available in this browser.",
      };
    }
    const available = await runtime.supportsBrowserTranscription();
    if (!available) {
      return {
        available: false,
        reason: "WebGPU is not available in this browser.",
      };
    }
    return {
      available: true,
      modelId: capabilities.modelId,
      models,
      runtime: capabilities.runtime,
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "Browser transcription is unavailable.",
    };
  }
}

type BrowserTranscriptionWorkerMessage =
  | { type: "result"; result: BrowserTranscriptionResult }
  | { type: "progress"; progress: BrowserTranscriptionProgress }
  | { type: "error"; message: string; name?: string };

export async function transcribeReferenceVideo(
  file: File,
  modelId: string,
  onProgress?: (progress: BrowserTranscriptionProgress) => void,
) {
  if (!modelId) {
    throw new Error("Select a browser transcription model before generating subtitles.");
  }

  const runtime = await loadRuntime();
  if (!(await runtime.supportsBrowserTranscription())) {
    throw new Error("WebGPU is required for browser subtitle generation.");
  }
  if (
    typeof AudioDecoder !== "function"
    || typeof EncodedAudioChunk !== "function"
    || typeof Worker !== "function"
  ) {
    throw new Error("Browser subtitle generation requires WebCodecs audio decoding.");
  }

  return new Promise<BrowserTranscriptionResult>((resolve, reject) => {
    const worker = new Worker(
      `${basePath()}/audio-transcription-worker.js`,
      { type: "module" },
    );
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<BrowserTranscriptionWorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.progress);
        return;
      }
      if (message.type === "result") {
        finish();
        resolve(message.result);
        return;
      }
      if (message.type === "error") {
        finish();
        if (message.name === "NotReadableError" || message.name === "NotFoundError") {
          reject(localFileReadError());
        } else {
          reject(new Error(message.message || "Browser subtitle generation failed."));
        }
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The browser transcription worker failed."));
    };
    worker.postMessage({
      type: "transcribe",
      file,
      modelId,
      wasmUrl: `${basePath()}/subtitle_merger_web_wasm.wasm`,
    });
  });
}
