type BrowserTranscriptionProgress = {
  stage?: string;
  message?: string;
  detail?: unknown;
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
  modelProvisioning: string;
  features: {
    transcription: boolean;
    timedSegments: boolean;
  };
  fallbacks: {
    server: boolean;
    python: boolean;
    cpu: boolean;
  };
};

type BrowserTranscriptionRuntime = {
  browserTranscriptionCapabilities: () => BrowserTranscriptionCapabilities;
  supportsBrowserTranscription: () => Promise<boolean>;
  transcribeAudioBlob: (
    source: Blob,
    options: {
      source: string;
      onProgress?: (progress: BrowserTranscriptionProgress) => void;
    },
  ) => Promise<BrowserTranscriptionResult>;
};

type RuntimeWindow = typeof window & {
  __subtitleMergerBrowserTranscription?: BrowserTranscriptionRuntime;
};

export type BrowserTranscriptionSupport =
  | {
      available: true;
      modelId: string;
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

function validateRuntime(runtime: BrowserTranscriptionRuntime | undefined) {
  if (
    !runtime
    || typeof runtime.browserTranscriptionCapabilities !== "function"
    || typeof runtime.supportsBrowserTranscription !== "function"
    || typeof runtime.transcribeAudioBlob !== "function"
  ) {
    throw new Error("The browser transcription runtime did not expose its expected capability surface.");
  }

  const capabilities = runtime.browserTranscriptionCapabilities();
  if (
    capabilities.requiredAcceleration !== "webgpu"
    || capabilities.features.transcription !== true
    || capabilities.features.timedSegments !== true
    || capabilities.fallbacks.server !== false
    || capabilities.fallbacks.python !== false
    || capabilities.fallbacks.cpu !== false
  ) {
    throw new Error("The browser transcription runtime no longer matches the reviewed local-only WebGPU contract.");
  }

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

export async function inspectBrowserTranscriptionSupport(): Promise<BrowserTranscriptionSupport> {
  try {
    const runtime = await loadRuntime();
    const capabilities = runtime.browserTranscriptionCapabilities();
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
      runtime: capabilities.runtime,
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "Browser transcription is unavailable.",
    };
  }
}

export async function transcribeReferenceVideo(
  file: File,
  onProgress?: (progress: BrowserTranscriptionProgress) => void,
) {
  const runtime = await loadRuntime();
  if (!(await runtime.supportsBrowserTranscription())) {
    throw new Error("WebGPU is required for browser subtitle generation.");
  }

  return runtime.transcribeAudioBlob(file, {
    source: file.name,
    onProgress,
  });
}
