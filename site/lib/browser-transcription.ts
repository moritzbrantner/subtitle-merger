const MAX_IN_MEMORY_REFERENCE_VIDEO_BYTES = 128 * 1024 * 1024;

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
    boundedPcmStreaming: boolean;
    mediaStreamAdapter: boolean;
  };
  fallbacks: {
    server: boolean;
    python: boolean;
    cpu: boolean;
  };
};

type BrowserMediaStreamTranscriptionSession = {
  finish: () => Promise<BrowserTranscriptionResult>;
  abort: (reason?: unknown) => Promise<void>;
};

type BrowserTranscriptionOptions = {
  source: string;
  onProgress?: (progress: BrowserTranscriptionProgress) => void;
};

type BrowserMediaStreamTranscriptionOptions = BrowserTranscriptionOptions & {
  onError?: (error: Error) => void;
};

type BrowserTranscriptionRuntime = {
  browserTranscriptionCapabilities: () => BrowserTranscriptionCapabilities;
  supportsBrowserTranscription: () => Promise<boolean>;
  transcribeAudioBlob: (
    source: Blob,
    options: BrowserTranscriptionOptions,
  ) => Promise<BrowserTranscriptionResult>;
  createBrowserMediaStreamTranscriptionSession: (
    stream: MediaStream,
    options: BrowserMediaStreamTranscriptionOptions,
  ) => Promise<BrowserMediaStreamTranscriptionSession>;
};

type RuntimeWindow = typeof window & {
  __subtitleMergerBrowserTranscription?: BrowserTranscriptionRuntime;
};

type CapturableVideoElement = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
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
    || typeof runtime.createBrowserMediaStreamTranscriptionSession !== "function"
  ) {
    throw new Error("The browser transcription runtime did not expose its expected capability surface.");
  }

  const capabilities = runtime.browserTranscriptionCapabilities();
  if (
    capabilities.requiredAcceleration !== "webgpu"
    || capabilities.features.transcription !== true
    || capabilities.features.timedSegments !== true
    || capabilities.features.boundedPcmStreaming !== true
    || capabilities.features.mediaStreamAdapter !== true
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

function captureStreamFor(video: CapturableVideoElement) {
  if (typeof video.captureStream === "function") {
    return video.captureStream();
  }
  if (typeof video.mozCaptureStream === "function") {
    return video.mozCaptureStream();
  }
  return undefined;
}

function supportsMediaElementCapture() {
  const video = document.createElement("video") as CapturableVideoElement;
  return (
    typeof video.captureStream === "function"
    || typeof video.mozCaptureStream === "function"
  );
}

function mediaError(video: HTMLVideoElement, fallback: string) {
  const message = video.error?.message?.trim();
  return new Error(message || fallback);
}

function waitForMediaCanPlay(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("error", handleError);
    };
    const handleCanPlay = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(mediaError(video, "The Reference Video could not be prepared for browser transcription."));
    };

    video.addEventListener("canplay", handleCanPlay, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function waitForMediaEnd(video: HTMLVideoElement) {
  if (video.ended) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("error", handleError);
    };
    const handleEnded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(mediaError(video, "The Reference Video stopped while browser transcription was running."));
    };

    video.addEventListener("ended", handleEnded, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function formatMediaTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function isWholeFileReadFailure(error: unknown) {
  if (error instanceof DOMException) {
    return error.name === "NotReadableError" || error.name === "NotFoundError";
  }
  if (error instanceof RangeError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("array buffer")
    || message.includes("arraybuffer")
    || message.includes("could not be read")
  );
}

async function transcribeReferenceVideoStream(
  runtime: BrowserTranscriptionRuntime,
  file: File,
  onProgress?: (progress: BrowserTranscriptionProgress) => void,
) {
  const video = document.createElement("video") as CapturableVideoElement;
  const objectUrl = URL.createObjectURL(file);
  let stream: MediaStream | undefined;
  let session: BrowserMediaStreamTranscriptionSession | undefined;
  let rejectRuntimeFailure: ((reason: Error) => void) | undefined;
  const runtimeFailure = new Promise<never>((_resolve, reject) => {
    rejectRuntimeFailure = reject;
  });

  video.preload = "auto";
  video.playsInline = true;
  video.muted = true;
  video.tabIndex = -1;
  video.setAttribute("aria-hidden", "true");
  video.style.position = "fixed";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.left = "-10000px";
  video.style.top = "0";
  video.src = objectUrl;
  document.body.append(video);

  const handleTimeUpdate = () => {
    if (!onProgress) {
      return;
    }
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    onProgress({
      stage: "capture",
      message: duration > 0
        ? `Streaming Reference Video audio locally… ${formatMediaTime(video.currentTime)} / ${formatMediaTime(duration)}`
        : `Streaming Reference Video audio locally… ${formatMediaTime(video.currentTime)}`,
    });
  };
  video.addEventListener("timeupdate", handleTimeUpdate);

  try {
    await waitForMediaCanPlay(video);
    stream = captureStreamFor(video);
    if (!stream) {
      throw new Error("This browser cannot expose Reference Video audio as a local MediaStream.");
    }
    if (stream.getAudioTracks().length === 0) {
      throw new Error("The selected Reference Video has no browser-decodable audio track.");
    }

    session = await runtime.createBrowserMediaStreamTranscriptionSession(stream, {
      source: file.name,
      ...(onProgress ? { onProgress } : {}),
      onError: (error) => rejectRuntimeFailure?.(error),
    });

    onProgress?.({
      stage: "capture",
      message: "Streaming Reference Video audio locally for bounded transcription…",
    });
    await video.play();
    await Promise.race([waitForMediaEnd(video), runtimeFailure]);
    return await session.finish();
  } catch (error) {
    if (session) {
      await session.abort(error);
    }
    throw error;
  } finally {
    video.removeEventListener("timeupdate", handleTimeUpdate);
    video.pause();
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

async function transcribeReferenceVideoBlob(
  runtime: BrowserTranscriptionRuntime,
  file: File,
  onProgress?: (progress: BrowserTranscriptionProgress) => void,
) {
  if (onProgress) {
    return runtime.transcribeAudioBlob(file, {
      source: file.name,
      onProgress,
    });
  }
  return runtime.transcribeAudioBlob(file, {
    source: file.name,
  });
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

  const canStream = supportsMediaElementCapture();
  if (canStream && file.size > MAX_IN_MEMORY_REFERENCE_VIDEO_BYTES) {
    return transcribeReferenceVideoStream(runtime, file, onProgress);
  }

  try {
    return await transcribeReferenceVideoBlob(runtime, file, onProgress);
  } catch (error) {
    if (!canStream || !isWholeFileReadFailure(error)) {
      throw error;
    }

    onProgress?.({
      stage: "capture",
      message: "The browser could not reread the whole video at once; switching to bounded local audio streaming…",
    });
    return transcribeReferenceVideoStream(runtime, file, onProgress);
  }
}
