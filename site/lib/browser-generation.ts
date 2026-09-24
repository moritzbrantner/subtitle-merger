import type { Track } from "./types";
import type { BrowserTranscriptionResult } from "./browser-transcription";

export type GeneratedVideoIdentity = {
  name: string;
  size: number;
  lastModified: number;
};

function generatedBaseName(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return base || "reference-video";
}

function segmentMilliseconds(value: number | null | undefined, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Browser transcription returned a segment without a valid ${label} time.`);
  }
  const milliseconds = Math.round(value * 1000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Browser transcription returned a ${label} time outside the supported range.`);
  }
  return milliseconds;
}

export function generatedSubtitleTrack(
  result: BrowserTranscriptionResult,
  video: GeneratedVideoIdentity,
): Track {
  const cues = [];
  for (const segment of result.segments ?? []) {
    const text = String(segment.text ?? "").trim();
    if (!text) {
      continue;
    }

    const startMs = segmentMilliseconds(segment.startSeconds, "start");
    const endMs = segmentMilliseconds(segment.endSeconds, "end");
    if (endMs < startMs) {
      throw new Error("Browser transcription returned a segment whose end precedes its start.");
    }

    cues.push({
      startMs,
      endMs,
      text,
      rawText: text,
    });
  }

  if (cues.length === 0) {
    throw new Error("Browser transcription did not return any timed subtitle segments.");
  }

  const baseName = generatedBaseName(video.name);
  return {
    id: `generated-${video.name}-${video.size}-${video.lastModified}`,
    title: "Generated",
    language: result.language?.trim() || "und",
    format: "srt",
    codec: "srt",
    origin: "generated",
    forced: false,
    filename: `${baseName}.generated.srt`,
    enabled: true,
    offsetMs: 0,
    cues,
  };
}
