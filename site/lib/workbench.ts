import type {
  BrowserTranscriptionModel,
  BrowserTranscriptionSupport,
} from "./browser-transcription";
import type { Cue, Track } from "./types";

export type CueDraft = {
  startMs: string;
  endMs: string;
  rawText: string;
};

export type CueSelection = {
  trackId: string;
  cueIndex: number;
};

export type InlineCueEdit = CueSelection & {
  rawText: string;
};

export type VisibleCue = {
  track: Track;
  trackIndex: number;
  cue: Cue;
  cueIndex: number;
};

export function selectionMatches(
  selection: CueSelection | undefined,
  trackId: string,
  cueIndex: number,
) {
  return selection?.trackId === trackId && selection.cueIndex === cueIndex;
}

export function fileTrackId(file: File) {
  return `file-${file.name}-${file.size}-${file.lastModified}`;
}

export function cueDraftKey(trackId: string, cueIndex: number) {
  return `${trackId}:${cueIndex}`;
}

export function draftFromCue(cue: Cue): CueDraft {
  return {
    startMs: String(cue.startMs),
    endMs: String(cue.endMs),
    rawText: cue.rawText ?? cue.text,
  };
}

export function shiftedTime(milliseconds: number, offsetMs: number) {
  return Math.max(0, milliseconds + offsetMs);
}

export function shiftedCue(cue: Cue, offsetMs: number): Cue {
  const startMs = shiftedTime(cue.startMs, offsetMs);
  return {
    ...cue,
    startMs,
    endMs: Math.max(startMs, shiftedTime(cue.endMs, offsetMs)),
  };
}

export function trackEnd(track: Track) {
  return track.cues.reduce(
    (end, cue) => Math.max(end, shiftedTime(cue.endMs, track.offsetMs)),
    0,
  );
}

export function trackOriginLabel(track: Track) {
  if (track.origin === "embedded") {
    return "Embedded track";
  }
  if (track.origin === "generated") {
    return track.filename ? `Generated · ${track.filename}` : "Generated subtitle";
  }
  return track.filename ?? "Imported subtitle file";
}

export function browserGenerationTitle(
  support: BrowserTranscriptionSupport | undefined,
  model: BrowserTranscriptionModel | undefined,
) {
  if (!support) {
    return "Checking WebGPU…";
  }
  if (!support.available) {
    return "WebGPU unavailable";
  }
  return model ? `Generate with ${model.label}` : "Select a Whisper model";
}

export function browserGenerationDescription(
  support: BrowserTranscriptionSupport | undefined,
  model: BrowserTranscriptionModel | undefined,
) {
  if (!support) {
    return "Checking whether this browser can run local transcription.";
  }
  if (!support.available) {
    return support.reason;
  }
  return model?.description ?? "Choose a reviewed browser Whisper model.";
}

export function formatByteCount(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function visibleCuesAt(
  tracks: Track[],
  positionMs: number,
  inlineCueEdit: InlineCueEdit | undefined,
): VisibleCue[] {
  const active = tracks.flatMap((track, trackIndex) => {
    if (!track.enabled) {
      return [];
    }
    const sourcePosition = positionMs - track.offsetMs;
    if (sourcePosition < 0) {
      return [];
    }
    const cueIndex = track.cues.findIndex(
      (cue) => cue.startMs <= sourcePosition && sourcePosition < cue.endMs,
    );
    const cue = track.cues[cueIndex];
    return cue ? [{ track, trackIndex, cue, cueIndex }] : [];
  });
  if (
    !inlineCueEdit
    || active.some(
      ({ track, cueIndex }) =>
        track.id === inlineCueEdit.trackId && cueIndex === inlineCueEdit.cueIndex,
    )
  ) {
    return active;
  }

  const trackIndex = tracks.findIndex((track) => track.id === inlineCueEdit.trackId);
  const track = tracks[trackIndex];
  const cue = track?.cues[inlineCueEdit.cueIndex];
  return track && cue
    ? [...active, { track, trackIndex, cue, cueIndex: inlineCueEdit.cueIndex }]
    : active;
}
