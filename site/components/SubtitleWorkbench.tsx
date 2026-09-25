"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { CueTimelineBlock } from "./CueTimelineBlock";
import { DriftCorrectionPanel } from "./DriftCorrectionPanel";
import { SubtitleQualityPanel } from "./SubtitleQualityPanel";
import { SubtitleSelectionBar } from "./SubtitleSelectionBar";
import { VideoSubtitleCue } from "./VideoSubtitleCue";
import {
  recordAcceptedDocument,
  redoAcceptedDocument,
  undoAcceptedDocument,
  type DocumentHistory,
} from "../lib/document-history";
import {
  capturedDriftAnchor,
  driftCorrectionRequest,
  emptyDriftCorrectionDraft,
  type DriftCorrectionDraft,
} from "../lib/drift-view";
import {
  formatClock,
  inferTrackTitle,
} from "../lib/subtitles";
import {
  clampCuePlacement,
  defaultCuePlacement,
  timelineMillisecondsFromPointer,
  type CuePlacement,
} from "../lib/editor-interaction";
import type {
  Cue,
  SubtitleQualityReport,
  Track,
  VideoInspection,
} from "../lib/types";
import { generatedSubtitleTrack } from "../lib/browser-generation";
import {
  inspectBrowserTranscriptionSupport,
  transcribeReferenceVideo,
  type BrowserTranscriptionSupport,
} from "../lib/browser-transcription";
import {
  analyzeSubtitleQuality,
  correctSubtitleDrift,
  editSubtitleCue,
  inspectVideo,
  mergeSubtitleCues,
  mergeTracks,
  parseSubtitle,
  splitSubtitleCue,
  type CueEditResult,
  type MergeFormat,
} from "../lib/wasm";

const videoAccept = ".mp4,.m4v,.mov,.mkv,.webm,video/*";
const subtitleAccept = ".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip,text/plain";

type CueDraft = {
  startMs: string;
  endMs: string;
  rawText: string;
};

type CueSelection = {
  trackId: string;
  cueIndex: number;
};

type InlineCueEdit = CueSelection & {
  rawText: string;
};

function selectionMatches(
  selection: CueSelection | undefined,
  trackId: string,
  cueIndex: number,
) {
  return selection?.trackId === trackId && selection.cueIndex === cueIndex;
}

function fileTrackId(file: File) {
  return `file-${file.name}-${file.size}-${file.lastModified}`;
}

function cueDraftKey(trackId: string, cueIndex: number) {
  return `${trackId}:${cueIndex}`;
}

function draftFromCue(cue: Cue): CueDraft {
  return {
    startMs: String(cue.startMs),
    endMs: String(cue.endMs),
    rawText: cue.rawText ?? cue.text,
  };
}

function shiftedTime(milliseconds: number, offsetMs: number) {
  return Math.max(0, milliseconds + offsetMs);
}

function shiftedCue(cue: Cue, offsetMs: number): Cue {
  const startMs = shiftedTime(cue.startMs, offsetMs);
  return {
    ...cue,
    startMs,
    endMs: Math.max(startMs, shiftedTime(cue.endMs, offsetMs)),
  };
}

function trackEnd(track: Track) {
  return track.cues.reduce(
    (end, cue) => Math.max(end, shiftedTime(cue.endMs, track.offsetMs)),
    0,
  );
}

function downloadName(track: Track, extension: string) {
  const slug = track.title
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug || "subtitles"}.${extension}`;
}

function sourceExtension(format: string) {
  switch (format.toLowerCase()) {
    case "webvtt":
    case "vtt":
      return "vtt";
    case "ass":
      return "ass";
    case "ssa":
      return "ssa";
    default:
      return "srt";
  }
}

function sourceMimeType(format: string) {
  return format.toLowerCase() === "webvtt" || format.toLowerCase() === "vtt"
    ? "text/vtt;charset=utf-8"
    : "text/plain;charset=utf-8";
}

function trackOriginLabel(track: Track) {
  if (track.origin === "embedded") {
    return "Embedded track";
  }
  if (track.origin === "generated") {
    return track.filename ? `Generated · ${track.filename}` : "Generated subtitle";
  }
  return track.filename ?? "Imported subtitle file";
}

function browserGenerationTitle(support: BrowserTranscriptionSupport | undefined) {
  if (!support) {
    return "Checking WebGPU…";
  }
  return support.available ? "Generate with WebGPU" : "WebGPU unavailable";
}

function browserGenerationDescription(
  support: BrowserTranscriptionSupport | undefined,
) {
  if (!support) {
    return "Checking whether this browser can run local transcription.";
  }
  if (!support.available) {
    return support.reason;
  }
  return "Whisper Tiny runs locally in this browser; model assets are cached after first use.";
}

function formatByteCount(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function triggerDownload(content: string, mimeType: string, filename: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function triggerByteDownload(content: Uint8Array, mimeType: string, filename: string) {
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SubtitleWorkbench() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  const cueEditInFlightRef = useRef(false);
  const qualityRequestRef = useRef(0);
  const cueTextRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const timelineScrubPointerRef = useRef<number | undefined>(undefined);
  const [videoFile, setVideoFile] = useState<File>();
  const [videoUrl, setVideoUrl] = useState("");
  const [inspection, setInspection] = useState<VideoInspection>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [selectedCue, setSelectedCue] = useState<CueSelection>();
  const [inlineCueEdit, setInlineCueEdit] = useState<InlineCueEdit>();
  const [cuePlacements, setCuePlacements] = useState<Record<string, CuePlacement>>({});
  const [cueDrafts, setCueDrafts] = useState<Record<string, CueDraft>>({});
  const [documentHistory, setDocumentHistory] = useState<Record<string, DocumentHistory>>({});
  const [driftDraft, setDriftDraft] = useState<DriftCorrectionDraft>(emptyDriftCorrectionDraft);
  const [positionMs, setPositionMs] = useState(0);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [qualityReport, setQualityReport] = useState<SubtitleQualityReport>();
  const [qualityError, setQualityError] = useState("");
  const [qualityBusy, setQualityBusy] = useState(false);
  const [browserTranscriptionSupport, setBrowserTranscriptionSupport] =
    useState<BrowserTranscriptionSupport>();
  const [generatingSubtitles, setGeneratingSubtitles] = useState(false);

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  useEffect(() => {
    return () => inspectionAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    let active = true;
    void inspectBrowserTranscriptionSupport().then((support) => {
      if (active) {
        setBrowserTranscriptionSupport(support);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const durationMs = useMemo(
    () =>
      Math.max(
        videoDurationMs,
        inspection?.durationMs ?? 0,
        ...tracks.map(trackEnd),
        1,
      ),
    [inspection?.durationMs, tracks, videoDurationMs],
  );

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) ?? tracks[0],
    [selectedTrackId, tracks],
  );

  const selectedTrackIndex = selectedTrack
    ? tracks.findIndex((track) => track.id === selectedTrack.id)
    : -1;
  const selectedHistory = selectedTrack ? documentHistory[selectedTrack.id] : undefined;
  const selectedTrackHasDrafts = selectedTrack
    ? Object.keys(cueDrafts).some((key) => key.startsWith(`${selectedTrack.id}:`))
    : false;
  const selectedCueContext = useMemo(() => {
    if (!selectedCue) {
      return undefined;
    }
    const trackIndex = tracks.findIndex((track) => track.id === selectedCue.trackId);
    const track = tracks[trackIndex];
    const cue = track?.cues[selectedCue.cueIndex];
    if (!track || !cue) {
      return undefined;
    }
    const key = cueDraftKey(track.id, selectedCue.cueIndex);
    return {
      track,
      trackIndex,
      cue,
      cueIndex: selectedCue.cueIndex,
      placement: cuePlacements[key] ?? defaultCuePlacement(trackIndex),
    };
  }, [cuePlacements, selectedCue, tracks]);

  useEffect(() => {
    setDriftDraft(emptyDriftCorrectionDraft());
  }, [selectedTrack?.id, selectedTrack?.sourceBytes]);

  useEffect(() => {
    const requestId = ++qualityRequestRef.current;
    const source = selectedTrack?.sourceBytes;
    setQualityReport(undefined);
    setQualityError("");

    if (!source) {
      setQualityBusy(false);
      return;
    }

    setQualityBusy(true);
    void analyzeSubtitleQuality(source)
      .then((report) => {
        if (qualityRequestRef.current === requestId) {
          setQualityReport(report);
        }
      })
      .catch((cause) => {
        if (qualityRequestRef.current === requestId) {
          setQualityError(
            cause instanceof Error ? cause.message : "Subtitle quality analysis failed.",
          );
        }
      })
      .finally(() => {
        if (qualityRequestRef.current === requestId) {
          setQualityBusy(false);
        }
      });
  }, [selectedTrack?.id, selectedTrack?.sourceBytes]);

  const visibleCues = useMemo(
    () =>
      tracks.flatMap((track, trackIndex) => {
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
      }),
    [positionMs, tracks],
  );

  async function handleVideoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    inspectionAbortRef.current?.abort();
    const controller = new AbortController();
    inspectionAbortRef.current = controller;

    setBusy("Inspecting video container with Rust/WASM…");
    setError("");
    setWarnings([]);
    setInspection(undefined);
    setVideoFile(file);
    setVideoDurationMs(0);
    setPositionMs(0);
    setTracks((current) => current.filter((track) => track.origin === "file"));
    setVideoUrl(URL.createObjectURL(file));

    try {
      const result = await inspectVideo(
        file,
        ({ phase, transferred }) => {
          if (inspectionAbortRef.current === controller) {
            setBusy(`${phase}… ${formatByteCount(transferred)} read locally`);
          }
        },
        controller.signal,
      );
      if (inspectionAbortRef.current !== controller) {
        return;
      }
      const embeddedTracks: Track[] = result.tracks.map((track) => ({
        ...track,
        enabled: true,
        offsetMs: 0,
      }));
      setInspection(result);
      setTracks((current) => {
        const files = current.filter((track) => track.origin === "file");
        return [...embeddedTracks, ...files];
      });
      setWarnings([
        ...result.warnings,
        ...result.unsupported.map(
          (track) => `${track.title} (${track.codec}): ${track.reason}`,
        ),
      ]);
      if (embeddedTracks[0]) {
        setSelectedTrackId(embeddedTracks[0].id);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      if (inspectionAbortRef.current === controller) {
        setError(cause instanceof Error ? cause.message : "The video could not be inspected.");
      }
    } finally {
      if (inspectionAbortRef.current === controller) {
        inspectionAbortRef.current = null;
        setBusy("");
      }
    }
  }

  function clearTrackBrowserState(trackIds: Set<string>) {
    const ids = [...trackIds];
    setCuePlacements((current) => {
      const next: Record<string, CuePlacement> = {};
      for (const [key, placement] of Object.entries(current)) {
        if (!ids.some((trackId) => key.startsWith(`${trackId}:`))) {
          next[key] = placement;
        }
      }
      return next;
    });
    setSelectedCue((current) =>
      current && trackIds.has(current.trackId) ? undefined : current,
    );
    setInlineCueEdit((current) =>
      current && trackIds.has(current.trackId) ? undefined : current,
    );
    setCueDrafts((current) => {
      const next: Record<string, CueDraft> = {};
      for (const [key, draft] of Object.entries(current)) {
        if (!ids.some((trackId) => key.startsWith(`${trackId}:`))) {
          next[key] = draft;
        }
      }
      return next;
    });
    setDocumentHistory((current) => {
      const next = { ...current };
      for (const trackId of trackIds) {
        delete next[trackId];
      }
      return next;
    });
    for (const key of Object.keys(cueTextRefs.current)) {
      if (ids.some((trackId) => key.startsWith(`${trackId}:`))) {
        delete cueTextRefs.current[key];
      }
    }
  }

  async function handleSubtitleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) {
      return;
    }

    setBusy(`Parsing ${files.length === 1 ? files[0].name : `${files.length} subtitle files`} with Rust/WASM…`);
    setError("");

    const imported: Track[] = [];
    const importedWarnings: string[] = [];
    for (const file of files) {
      try {
        const sourceBytes = new Uint8Array(await file.arrayBuffer());
        const parsed = await parseSubtitle(file);
        const track: Track = {
          id: fileTrackId(file),
          title: inferTrackTitle(file.name, videoFile?.name),
          language: "und",
          format: parsed.format,
          codec: parsed.format,
          origin: "file",
          forced: false,
          filename: file.name,
          enabled: true,
          offsetMs: 0,
          cues: parsed.cues,
          sourceBytes,
        };
        imported.push(track);
        importedWarnings.push(...parsed.warnings.map((warning) => `${file.name}: ${warning}`));
      } catch (cause) {
        importedWarnings.push(
          `${file.name}: ${cause instanceof Error ? cause.message : "could not be parsed"}`,
        );
      }
    }

    const importedIds = new Set(imported.map((track) => track.id));
    setTracks((current) => [
      ...current.filter((track) => !importedIds.has(track.id)),
      ...imported,
    ]);
    clearTrackBrowserState(importedIds);
    setWarnings((current) => [...current, ...importedWarnings]);
    if (!selectedTrackId && imported[0]) {
      setSelectedTrackId(imported[0].id);
    }
    setBusy("");
  }

  async function handleGenerateSubtitles() {
    if (
      !videoFile
      || browserTranscriptionSupport?.available !== true
      || generatingSubtitles
    ) {
      return;
    }

    const sourceVideo = videoFile;
    setGeneratingSubtitles(true);
    setBusy("Preparing browser transcription…");
    setError("");

    try {
      const transcript = await transcribeReferenceVideo(sourceVideo, (progress) => {
        if (progress.message) {
          setBusy(progress.message);
        }
      });
      const generated = generatedSubtitleTrack(transcript, {
        name: sourceVideo.name,
        size: sourceVideo.size,
        lastModified: sourceVideo.lastModified,
      });

      setBusy("Serializing generated subtitles with Rust/WASM…");
      const serialized = await mergeTracks([generated], "srt");
      const track: Track = {
        ...generated,
        sourceBytes: new TextEncoder().encode(serialized.content),
      };
      const generatedIds = new Set([track.id]);
      setTracks((current) => [
        ...current.filter((candidate) => candidate.id !== track.id),
        track,
      ]);
      clearTrackBrowserState(generatedIds);
      setSelectedTrackId(track.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Browser subtitle generation failed.",
      );
    } finally {
      setGeneratingSubtitles(false);
      setBusy("");
    }
  }

  function toggleTrack(id: string) {
    setTracks((current) =>
      current.map((track) =>
        track.id === id ? { ...track, enabled: !track.enabled } : track,
      ),
    );
  }

  function setTrackOffset(id: string, offsetMs: number) {
    if (!Number.isFinite(offsetMs)) {
      return;
    }
    setTracks((current) =>
      current.map((track) =>
        track.id === id ? { ...track, offsetMs: Math.trunc(offsetMs) } : track,
      ),
    );
  }

  function setCueDraftValue(
    track: Track,
    cueIndex: number,
    cue: Cue,
    field: keyof CueDraft,
    value: string,
  ) {
    const key = cueDraftKey(track.id, cueIndex);
    setCueDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? draftFromCue(cue)),
        [field]: value,
      },
    }));
  }

  function setDriftDraftValue(
    anchor: "first" | "second",
    field: "sourceMs" | "referenceMs",
    value: string,
  ) {
    setDriftDraft((current) => ({
      ...current,
      [anchor]: {
        ...current[anchor],
        [field]: value,
      },
    }));
  }

  function replaceTrackDocument(track: Track, edited: CueEditResult) {
    const sourceBytes = new TextEncoder().encode(edited.content);
    setTracks((current) =>
      current.map((candidate) =>
        candidate.id === track.id
          ? {
              ...candidate,
              format: edited.format,
              codec: edited.format,
              cues: edited.cues,
              sourceBytes,
            }
          : candidate,
      ),
    );
  }

  function recordTrackDocument(track: Track) {
    if (!track.sourceBytes) {
      return;
    }
    const sourceBytes = track.sourceBytes;
    setDocumentHistory((current) => ({
      ...current,
      [track.id]: recordAcceptedDocument(current[track.id], sourceBytes),
    }));
  }

  function acceptTrackDocument(track: Track, edited: CueEditResult) {
    recordTrackDocument(track);
    replaceTrackDocument(track, edited);
  }

  function clearCueDraft(trackId: string, cueIndex: number) {
    setCueDrafts((current) => {
      const next = { ...current };
      delete next[cueDraftKey(trackId, cueIndex)];
      return next;
    });
  }

  function remapCueBrowserState(
    trackId: string,
    remap: (cueIndex: number) => number | undefined,
  ) {
    const prefix = `${trackId}:`;
    setCueDrafts((current) => {
      const next: Record<string, CueDraft> = {};
      for (const [key, draft] of Object.entries(current)) {
        if (!key.startsWith(prefix)) {
          next[key] = draft;
          continue;
        }
        const sourceIndex = Number(key.slice(prefix.length));
        const targetIndex = remap(sourceIndex);
        if (targetIndex !== undefined) {
          next[cueDraftKey(trackId, targetIndex)] = draft;
        }
      }
      return next;
    });
    setCuePlacements((current) => {
      const next: Record<string, CuePlacement> = {};
      for (const [key, placement] of Object.entries(current)) {
        if (!key.startsWith(prefix)) {
          next[key] = placement;
          continue;
        }
        const sourceIndex = Number(key.slice(prefix.length));
        const targetIndex = remap(sourceIndex);
        if (targetIndex !== undefined) {
          next[cueDraftKey(trackId, targetIndex)] = placement;
        }
      }
      return next;
    });
    setSelectedCue((current) => {
      if (!current || current.trackId !== trackId) {
        return current;
      }
      const targetIndex = remap(current.cueIndex);
      return targetIndex === undefined ? undefined : { trackId, cueIndex: targetIndex };
    });
    setInlineCueEdit((current) => {
      if (!current || current.trackId !== trackId) {
        return current;
      }
      const targetIndex = remap(current.cueIndex);
      return targetIndex === undefined
        ? undefined
        : { ...current, cueIndex: targetIndex };
    });
    for (const key of Object.keys(cueTextRefs.current)) {
      if (key.startsWith(prefix)) {
        delete cueTextRefs.current[key];
      }
    }
  }

  async function applyCueDraftToSource(
    source: Uint8Array,
    track: Track,
    cueIndex: number,
    cue: Cue,
  ) {
    const draft = cueDrafts[cueDraftKey(track.id, cueIndex)];
    if (!draft) {
      return source;
    }
    if (draft.startMs.trim() === "" || draft.endMs.trim() === "") {
      throw new Error("Cue start and end times are required.");
    }
    const edited = await editSubtitleCue(source, {
      cueIndex,
      startMs: Number(draft.startMs),
      endMs: Number(draft.endMs),
      rawText: draft.rawText,
    });
    return new TextEncoder().encode(edited.content);
  }

  async function saveCueEdit(track: Track, cueIndex: number, cue: Cue) {
    if (cueEditInFlightRef.current) {
      return;
    }
    if (!track.sourceBytes) {
      setError("This embedded track does not yet retain a source document for lossless editing.");
      return;
    }
    const key = cueDraftKey(track.id, cueIndex);
    const draft = cueDrafts[key] ?? draftFromCue(cue);
    if (draft.startMs.trim() === "" || draft.endMs.trim() === "") {
      setError("Cue start and end times are required.");
      return;
    }
    const startMs = Number(draft.startMs);
    const endMs = Number(draft.endMs);

    cueEditInFlightRef.current = true;
    setBusy(`Saving cue ${cueIndex + 1} through Rust/WASM…`);
    setError("");
    try {
      const edited = await editSubtitleCue(track.sourceBytes, {
        cueIndex,
        startMs,
        endMs,
        rawText: draft.rawText,
      });
      acceptTrackDocument(track, edited);
      clearCueDraft(track.id, cueIndex);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cue edit could not be applied.");
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
  }

  async function commitTimelineCueTiming(
    track: Track,
    cueIndex: number,
    cue: Cue,
    startMs: number,
    endMs: number,
  ) {
    if (cueEditInFlightRef.current || !track.sourceBytes) {
      return false;
    }
    if (cueDrafts[cueDraftKey(track.id, cueIndex)]) {
      setError("Save this cue's pending draft before changing its timing on the timeline.");
      return false;
    }

    cueEditInFlightRef.current = true;
    setBusy(`Updating cue ${cueIndex + 1} timing through Rust/WASM…`);
    setError("");
    try {
      const edited = await editSubtitleCue(track.sourceBytes, {
        cueIndex,
        startMs,
        endMs,
        rawText: cue.rawText ?? cue.text,
      });
      acceptTrackDocument(track, edited);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cue timing could not be updated.");
      return false;
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
  }

  async function splitCueAtPlayhead(track: Track, cueIndex: number, cue: Cue) {
    if (cueEditInFlightRef.current) {
      return;
    }
    if (!track.sourceBytes) {
      setError("This embedded track does not yet retain a source document for lossless editing.");
      return;
    }
    const key = cueDraftKey(track.id, cueIndex);
    const textarea = cueTextRefs.current[key];
    if (!textarea) {
      setError("The cue text editor is not available for splitting.");
      return;
    }
    const mediaTimeSeconds = videoRef.current?.currentTime;
    const playheadMs = mediaTimeSeconds !== undefined && Number.isFinite(mediaTimeSeconds)
      ? mediaTimeSeconds * 1000
      : positionMs;

    cueEditInFlightRef.current = true;
    setBusy(`Splitting cue ${cueIndex + 1} through Rust/WASM…`);
    setError("");
    try {
      const source = await applyCueDraftToSource(track.sourceBytes, track, cueIndex, cue);
      const edited = await splitSubtitleCue(source, {
        cueIndex,
        splitMs: Math.trunc(playheadMs - track.offsetMs),
        textOffsetUtf16: textarea.selectionStart,
      });
      acceptTrackDocument(track, edited);
      remapCueBrowserState(track.id, (draftIndex) => {
        if (draftIndex === cueIndex) {
          return undefined;
        }
        return draftIndex > cueIndex ? draftIndex + 1 : draftIndex;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cue could not be split.");
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
  }

  async function mergeCueWithNext(track: Track, cueIndex: number, cue: Cue) {
    if (cueEditInFlightRef.current) {
      return;
    }
    if (!track.sourceBytes) {
      setError("This embedded track does not yet retain a source document for lossless editing.");
      return;
    }
    const nextCue = track.cues[cueIndex + 1];
    if (!nextCue) {
      setError("Merge requires a following cue.");
      return;
    }

    cueEditInFlightRef.current = true;
    setBusy(`Merging cue ${cueIndex + 1} with the next cue through Rust/WASM…`);
    setError("");
    try {
      let source = await applyCueDraftToSource(track.sourceBytes, track, cueIndex, cue);
      source = await applyCueDraftToSource(source, track, cueIndex + 1, nextCue);
      const edited = await mergeSubtitleCues(source, cueIndex);
      acceptTrackDocument(track, edited);
      remapCueBrowserState(track.id, (draftIndex) => {
        if (draftIndex === cueIndex || draftIndex === cueIndex + 1) {
          return undefined;
        }
        return draftIndex > cueIndex + 1 ? draftIndex - 1 : draftIndex;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cues could not be merged.");
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
  }

  function trackHasCueDrafts(trackId: string) {
    return Object.keys(cueDrafts).some((key) => key.startsWith(`${trackId}:`));
  }

  function captureDriftAnchor(
    track: Track,
    cue: Cue,
    anchor: "first" | "second",
  ) {
    if (cueDrafts[cueDraftKey(track.id, track.cues.indexOf(cue))]) {
      setError("Save this cue's pending draft before using it as a drift anchor.");
      return;
    }
    const mediaTimeSeconds = videoRef.current?.currentTime;
    const referenceMs = mediaTimeSeconds !== undefined && Number.isFinite(mediaTimeSeconds)
      ? mediaTimeSeconds * 1000
      : positionMs;
    setDriftDraft((current) => ({
      ...current,
      [anchor]: capturedDriftAnchor(cue.startMs, referenceMs),
    }));
    setError("");
  }

  async function applyDriftCorrectionToTrack(track: Track) {
    if (cueEditInFlightRef.current) {
      return;
    }
    if (!track.sourceBytes) {
      setError("This track does not have an editable source document for drift correction.");
      return;
    }
    if (trackHasCueDrafts(track.id)) {
      setError("Save pending cue drafts before applying drift correction.");
      return;
    }

    let correction;
    try {
      correction = driftCorrectionRequest(driftDraft, track.offsetMs);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The drift anchors are invalid.");
      return;
    }

    cueEditInFlightRef.current = true;
    setBusy(`Applying two-anchor drift correction to ${track.title} through Rust/WASM…`);
    setError("");
    try {
      const edited = await correctSubtitleDrift(track.sourceBytes, correction);
      acceptTrackDocument(track, edited);
      setDriftDraft(emptyDriftCorrectionDraft());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The drift correction could not be applied.");
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
  }

  async function restoreAcceptedDocument(track: Track, direction: "undo" | "redo") {
    if (cueEditInFlightRef.current) {
      return;
    }
    if (!track.sourceBytes) {
      setError("This track does not have an editable source document.");
      return;
    }
    if (trackHasCueDrafts(track.id)) {
      setError("Save pending cue drafts before using undo or redo.");
      return;
    }

    const history = documentHistory[track.id];
    const step = direction === "undo"
      ? undoAcceptedDocument(history, track.sourceBytes)
      : redoAcceptedDocument(history, track.sourceBytes);
    if (!step) {
      return;
    }

    cueEditInFlightRef.current = true;
    setBusy(`${direction === "undo" ? "Undoing" : "Redoing"} accepted cue edit…`);
    setError("");
    try {
      const copy = new Uint8Array(step.source.byteLength);
      copy.set(step.source);
      const restored = await parseSubtitle(
        new File([copy.buffer], `history.${sourceExtension(track.format)}`),
      );
      if (restored.warnings.length > 0) {
        throw new Error(
          `The stored ${direction} state could not be restored losslessly: ${restored.warnings.join(" ")}`,
        );
      }
      setTracks((current) =>
        current.map((candidate) =>
          candidate.id === track.id
            ? {
                ...candidate,
                format: restored.format,
                codec: restored.format,
                cues: restored.cues,
                sourceBytes: step.source,
              }
            : candidate,
        ),
      );
      setDocumentHistory((current) => ({
        ...current,
        [track.id]: step.history,
      }));
      for (const key of Object.keys(cueTextRefs.current)) {
        if (key.startsWith(`${track.id}:`)) {
          delete cueTextRefs.current[key];
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${direction} operation failed.`);
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
  }

  function moveTrack(id: string, direction: -1 | 1) {
    setTracks((current) => {
      const index = current.findIndex((track) => track.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeTrack(id: string) {
    setTracks((current) => current.filter((track) => track.id !== id));
    clearTrackBrowserState(new Set([id]));
    if (selectedTrackId === id) {
      setSelectedTrackId("");
    }
  }

  function seek(milliseconds: number) {
    const bounded = Math.min(durationMs, Math.max(0, milliseconds));
    setPositionMs(bounded);
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = bounded / 1000;
  }

  function selectCue(trackId: string, cueIndex: number) {
    setSelectedTrackId(trackId);
    setSelectedCue({ trackId, cueIndex });
  }

  function setCuePlacement(trackId: string, cueIndex: number, placement: CuePlacement) {
    setCuePlacements((current) => ({
      ...current,
      [cueDraftKey(trackId, cueIndex)]: clampCuePlacement(placement),
    }));
  }

  function beginInlineCueEdit(track: Track, cueIndex: number, cue: Cue) {
    selectCue(track.id, cueIndex);
    if (!track.sourceBytes) {
      setError("This subtitle track does not retain an editable source document.");
      return;
    }
    if (cueDrafts[cueDraftKey(track.id, cueIndex)]) {
      setError("Save the pending cue draft before editing this subtitle directly in the video.");
      return;
    }
    setInlineCueEdit({
      trackId: track.id,
      cueIndex,
      rawText: cue.rawText ?? cue.text,
    });
    setError("");
  }

  async function commitInlineCueEdit() {
    const edit = inlineCueEdit;
    if (!edit || cueEditInFlightRef.current) {
      return;
    }
    const track = tracks.find((candidate) => candidate.id === edit.trackId);
    const cue = track?.cues[edit.cueIndex];
    if (!track?.sourceBytes || !cue) {
      setInlineCueEdit(undefined);
      return;
    }
    const original = cue.rawText ?? cue.text;
    if (edit.rawText === original) {
      setInlineCueEdit(undefined);
      return;
    }
    if (edit.rawText.trim() === "") {
      setError("Cue text must not be empty.");
      return;
    }

    cueEditInFlightRef.current = true;
    setBusy(`Saving cue ${edit.cueIndex + 1} through Rust/WASM…`);
    setError("");
    try {
      const edited = await editSubtitleCue(track.sourceBytes, {
        cueIndex: edit.cueIndex,
        startMs: cue.startMs,
        endMs: cue.endMs,
        rawText: edit.rawText,
      });
      acceptTrackDocument(track, edited);
      setInlineCueEdit(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cue text could not be updated.");
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
  }

  function seekFromTimelinePointer(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    seek(
      timelineMillisecondsFromPointer(
        event.clientX,
        bounds.left,
        bounds.width,
        durationMs,
      ),
    );
  }

  function beginTimelineScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    timelineScrubPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromTimelinePointer(event);
    event.preventDefault();
  }

  function moveTimelineScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (timelineScrubPointerRef.current !== event.pointerId) {
      return;
    }
    seekFromTimelinePointer(event);
    event.preventDefault();
  }

  function endTimelineScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (timelineScrubPointerRef.current !== event.pointerId) {
      return;
    }
    timelineScrubPointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleTimelineKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10_000 : 1_000;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seek(positionMs - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seek(positionMs + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      seek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      seek(durationMs);
    }
  }

  function selectQualityCue(cueIndex: number) {
    const cue = selectedTrack?.cues[cueIndex];
    if (!selectedTrack || !cue) {
      return;
    }
    seek(shiftedTime(cue.startMs, selectedTrack.offsetMs));
  }

  function downloadSourceTrack(track: Track) {
    if (!track.sourceBytes) {
      return;
    }
    const extension = sourceExtension(track.format);
    triggerByteDownload(
      track.sourceBytes,
      sourceMimeType(track.format),
      downloadName(track, extension),
    );
  }

  async function downloadTrack(track: Track, format: "srt" | "vtt") {
    setBusy(`Converting ${track.title} to ${format.toUpperCase()} with Rust/WASM…`);
    setError("");
    try {
      const result = await mergeTracks([{ ...track, enabled: true }], format);
      triggerDownload(result.content, result.mimeType, downloadName(track, result.extension));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The subtitle track could not be converted.");
    } finally {
      setBusy("");
    }
  }

  async function downloadMerged(format: MergeFormat) {
    setBusy(`Merging enabled tracks as ${format.toUpperCase()} with Rust/WASM…`);
    setError("");
    try {
      const result = await mergeTracks(tracks, format);
      triggerDownload(
        result.content,
        result.mimeType,
        `merged-subtitles.${result.extension}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The subtitle tracks could not be merged.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="workbench">
      <section className="import-panel" aria-labelledby="import-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Local inputs</p>
            <h2 id="import-heading">Reference video and subtitle files</h2>
          </div>
          <p className="privacy-note">Processed locally. Nothing is uploaded.</p>
        </div>

        <div className="input-grid">
          <label className="file-target">
            <span className="file-target-label">Reference video</span>
            <strong>{videoFile?.name ?? "Choose one video file"}</strong>
            <span>MP4/MOV and Matroska/WebM can be inspected for embedded text subtitles.</span>
            <input
              type="file"
              accept={videoAccept}
              disabled={generatingSubtitles}
              onChange={handleVideoChange}
            />
          </label>

          <label className="file-target">
            <span className="file-target-label">Subtitle files</span>
            <strong>Add SRT, WebVTT, ASS, or SSA</strong>
            <span>Select several files at once; importing the same file again replaces that track.</span>
            <input
              type="file"
              accept={subtitleAccept}
              multiple
              disabled={generatingSubtitles}
              onChange={handleSubtitleChange}
            />
          </label>

          <button
            type="button"
            className="file-target browser-generate-target"
            disabled={
              !videoFile
              || Boolean(busy)
              || generatingSubtitles
              || browserTranscriptionSupport?.available !== true
            }
            onClick={() => void handleGenerateSubtitles()}
          >
            <span className="file-target-label">Generate subtitles</span>
            <strong>{browserGenerationTitle(browserTranscriptionSupport)}</strong>
            <span>{browserGenerationDescription(browserTranscriptionSupport)}</span>
          </button>
        </div>

        {busy ? <p className="status-line">{busy}</p> : null}
        {error ? <p className="error-line">{error}</p> : null}
        {warnings.length > 0 ? (
          <details className="warnings">
            <summary>Warnings ({warnings.length})</summary>
            <ul>
              {warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <div className="video-editor-stack">
      <section className="preview-panel" aria-labelledby="preview-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Reference video</p>
            <h2 id="preview-heading">Preview</h2>
          </div>
          {inspection ? (
            <p className="container-label">
              {inspection.container} · {inspection.durationMs ? formatClock(inspection.durationMs) : "duration from browser"}
            </p>
          ) : null}
        </div>

        <div className="video-stage">
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                playsInline
                onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
                onLoadedMetadata={(event) => {
                  if (Number.isFinite(event.currentTarget.duration)) {
                    setVideoDurationMs(event.currentTarget.duration * 1000);
                  }
                }}
              />
              {visibleCues.length > 0 ? (
                <div className="subtitle-overlay" aria-live="off">
                  {visibleCues.map(({ track, trackIndex, cue, cueIndex }) => {
                    const key = cueDraftKey(track.id, cueIndex);
                    const editing = selectionMatches(inlineCueEdit, track.id, cueIndex);
                    return (
                      <VideoSubtitleCue
                        key={key}
                        trackId={track.id}
                        trackTitle={track.title}
                        cueIndex={cueIndex}
                        text={cue.text}
                        placement={cuePlacements[key] ?? defaultCuePlacement(trackIndex)}
                        selected={selectionMatches(selectedCue, track.id, cueIndex)}
                        editable={Boolean(track.sourceBytes)}
                        editing={editing}
                        editText={editing ? inlineCueEdit?.rawText ?? "" : ""}
                        busy={Boolean(busy)}
                        onSelect={() => selectCue(track.id, cueIndex)}
                        onMove={(placement) => setCuePlacement(track.id, cueIndex, placement)}
                        onBeginTextEdit={() => beginInlineCueEdit(track, cueIndex, cue)}
                        onEditTextChange={(rawText) =>
                          setInlineCueEdit((current) =>
                            current && selectionMatches(current, track.id, cueIndex)
                              ? { ...current, rawText }
                              : current,
                          )
                        }
                        onCommitTextEdit={commitInlineCueEdit}
                        onCancelTextEdit={() => setInlineCueEdit(undefined)}
                      />
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-stage">
              <p>Select a reference video to start.</p>
              <span>The browser may not be able to play every codec even when Rust can inspect its container.</span>
            </div>
          )}
        </div>
        {selectedCueContext ? (
          <SubtitleSelectionBar
            trackTitle={selectedCueContext.track.title}
            cueIndex={selectedCueContext.cueIndex}
            placement={selectedCueContext.placement}
            editable={Boolean(selectedCueContext.track.sourceBytes)}
            busy={Boolean(busy)}
            onPlacementChange={(placement) =>
              setCuePlacement(
                selectedCueContext.track.id,
                selectedCueContext.cueIndex,
                placement,
              )
            }
            onEditText={() =>
              beginInlineCueEdit(
                selectedCueContext.track,
                selectedCueContext.cueIndex,
                selectedCueContext.cue,
              )
            }
          />
        ) : null}
      </section>

      <section className="tracks-panel" aria-labelledby="tracks-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Timeline</p>
            <h2 id="tracks-heading">Subtitle tracks</h2>
          </div>
          <p className="time-readout">{formatClock(positionMs)}</p>
        </div>

        {tracks.length === 0 ? (
          <p className="empty-copy">
            Embedded text tracks appear here after video inspection. You can also add subtitle files before or after selecting a video.
          </p>
        ) : (
          <div className="timeline" data-testid="subtitle-timeline">
            <div
              className="timeline-ruler"
              role="slider"
              tabIndex={0}
              aria-label="Video timeline"
              aria-valuemin={0}
              aria-valuemax={Math.round(durationMs)}
              aria-valuenow={Math.round(positionMs)}
              aria-valuetext={formatClock(positionMs)}
              data-testid="timeline-scrubber"
              onPointerDown={beginTimelineScrub}
              onPointerMove={moveTimelineScrub}
              onPointerUp={endTimelineScrub}
              onPointerCancel={endTimelineScrub}
              onKeyDown={handleTimelineKeyDown}
            >
              <span>0</span>
              <span>{formatClock(durationMs / 2)}</span>
              <span>{formatClock(durationMs)}</span>
            </div>
            {tracks.map((track) => (
              <div className="timeline-row" key={track.id}>
                <div className={`track-label${selectedTrack?.id === track.id ? " is-selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={track.enabled}
                    aria-label={`Enable ${track.title}`}
                    onChange={() => toggleTrack(track.id)}
                  />
                  <button
                    type="button"
                    className="track-select-button"
                    aria-pressed={selectedTrack?.id === track.id}
                    onClick={() => {
                      setSelectedTrackId(track.id);
                      setSelectedCue((current) =>
                        current?.trackId === track.id ? current : undefined,
                      );
                      setInlineCueEdit((current) =>
                        current?.trackId === track.id ? current : undefined,
                      );
                    }}
                  >
                    <strong>{track.title}</strong>
                    <small>
                      {track.origin === "embedded" ? "embedded" : track.filename} · {track.codec} · {track.cues.length} cues
                      {track.offsetMs !== 0 ? ` · offset ${track.offsetMs > 0 ? "+" : ""}${track.offsetMs} ms` : ""}
                    </small>
                  </button>
                </div>
                <div
                  className="cue-lane"
                  data-testid="subtitle-timeline-lane"
                  data-track-id={track.id}
                  onPointerDown={beginTimelineScrub}
                  onPointerMove={moveTimelineScrub}
                  onPointerUp={endTimelineScrub}
                  onPointerCancel={endTimelineScrub}
                >
                  <span
                    className="timeline-playhead"
                    aria-hidden="true"
                    style={{ left: `${Math.min(100, Math.max(0, (positionMs / durationMs) * 100))}%` }}
                  />
                  {track.cues.map((cue, index) => (
                    <CueTimelineBlock
                      key={`${cue.startMs}-${cue.endMs}-${index}`}
                      cue={cue}
                      cueIndex={index}
                      trackTitle={track.title}
                      trackOffsetMs={track.offsetMs}
                      timelineDurationMs={durationMs}
                      editable={Boolean(track.sourceBytes) && !cueDrafts[cueDraftKey(track.id, index)]}
                      selected={selectionMatches(selectedCue, track.id, index)}
                      busy={Boolean(busy)}
                      onSelect={() => selectCue(track.id, index)}
                      onSeek={seek}
                      onCommitTiming={(startMs, endMs) =>
                        commitTimelineCueTiming(track, index, cue, startMs, endMs)
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      </div>

      {tracks.length > 0 ? (
        <section className="merge-panel" aria-labelledby="merge-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Merge</p>
              <h2 id="merge-heading">Export enabled tracks in timeline order</h2>
            </div>
            <div className="merge-actions">
              <button type="button" onClick={() => downloadMerged("ass")}>Merged ASS</button>
              <button type="button" onClick={() => downloadMerged("srt")}>Merged SRT</button>
              <button type="button" onClick={() => downloadMerged("vtt")}>Merged WebVTT</button>
            </div>
          </div>
          <p className="merge-note">
            ASS keeps tracks simultaneous with one deterministic style/vertical position per track. SRT and WebVTT split the timeline at cue boundaries and join overlapping active track text in the order shown above.
          </p>
        </section>
      ) : null}

      {selectedTrack ? (
        <section className="detail-panel" aria-labelledby="detail-heading">
          <div className="section-heading detail-heading">
            <div>
              <p className="eyebrow">Track detail</p>
              <h2 id="detail-heading">{selectedTrack.title}</h2>
              <p className="track-meta">
                {trackOriginLabel(selectedTrack)} · {selectedTrack.format}
                {selectedTrack.language !== "und" ? ` · ${selectedTrack.language}` : ""}
                {selectedTrack.forced ? " · forced" : ""}
              </p>
            </div>
            <div className="detail-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={selectedTrackIndex <= 0}
                onClick={() => moveTrack(selectedTrack.id, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={selectedTrackIndex < 0 || selectedTrackIndex >= tracks.length - 1}
                onClick={() => moveTrack(selectedTrack.id, 1)}
              >
                Move down
              </button>
              {selectedTrack.sourceBytes ? (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={Boolean(busy) || selectedTrackHasDrafts || !selectedHistory?.undo.length}
                    title={selectedTrackHasDrafts ? "Save pending cue drafts before undoing accepted edits." : undefined}
                    onClick={() => restoreAcceptedDocument(selectedTrack, "undo")}
                  >
                    Undo edit
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={Boolean(busy) || selectedTrackHasDrafts || !selectedHistory?.redo.length}
                    title={selectedTrackHasDrafts ? "Save pending cue drafts before redoing accepted edits." : undefined}
                    onClick={() => restoreAcceptedDocument(selectedTrack, "redo")}
                  >
                    Redo edit
                  </button>
                  <button type="button" onClick={() => downloadSourceTrack(selectedTrack)}>Download source</button>
                </>
              ) : null}
              <button type="button" onClick={() => downloadTrack(selectedTrack, "srt")}>Convert to SRT</button>
              <button type="button" onClick={() => downloadTrack(selectedTrack, "vtt")}>Convert to VTT</button>
              <button type="button" className="secondary-button" onClick={() => removeTrack(selectedTrack.id)}>Remove</button>
            </div>
          </div>

          <label className="offset-control">
            <span>Track offset (milliseconds)</span>
            <input
              type="number"
              step="100"
              value={selectedTrack.offsetMs}
              onChange={(event) => setTrackOffset(selectedTrack.id, Number(event.currentTarget.value))}
            />
            <small>Positive values delay this track; negative values move it earlier. Preview plus converted and merged exports use this offset; Download source preserves source-document timing.</small>
          </label>

          <DriftCorrectionPanel
            trackTitle={selectedTrack.title}
            trackOffsetMs={selectedTrack.offsetMs}
            sourceAvailable={Boolean(selectedTrack.sourceBytes)}
            busy={Boolean(busy)}
            hasCueDrafts={selectedTrackHasDrafts}
            draft={driftDraft}
            onChange={setDriftDraftValue}
            onClear={() => setDriftDraft(emptyDriftCorrectionDraft())}
            onApply={() => applyDriftCorrectionToTrack(selectedTrack)}
          />

          <SubtitleQualityPanel
            trackTitle={selectedTrack.title}
            sourceAvailable={Boolean(selectedTrack.sourceBytes)}
            report={qualityReport}
            busy={qualityBusy}
            error={qualityError}
            onSelectCue={selectQualityCue}
          />

          {selectedTrack.sourceBytes ? (
            <p className="merge-note">
              Cue timing, text, split, merge, timeline timing, and two-anchor drift correction are applied atomically through Rust before replacing this track. Drift anchors capture a cue's accepted source start against the current reference playhead; the whole-track offset stays separate. Drag a cue to move it; drag its edge handles to resize it. Keyboard focus on the cue or handles uses Left/Right for 100 ms and Shift+Left/Right for one second. Timeline editing and drift application are disabled while there are unsaved cue drafts. Split uses the current video playhead and the source-text caret; Merge next includes any unsaved drafts for both cues. Undo/redo keeps accepted source-document states in bounded browser memory and reparses a restored state through Rust. Track offset and track ordering are not part of this source-edit history. For ASS/SSA and marked-up WebVTT, the source-text field intentionally exposes format markup so editing text does not silently discard it.
            </p>
          ) : (
            <p className="merge-note">
              Embedded tracks are read-only in this slice because their extracted source document is not retained yet. They can still be offset, reordered, converted, and merged.
            </p>
          )}

          <div className="cue-table-wrap">
            <table className="cue-table">
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End</th>
                  <th>Text</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {selectedTrack.cues.map((cue, index) => {
                  const adjusted = shiftedCue(cue, selectedTrack.offsetMs);
                  const key = cueDraftKey(selectedTrack.id, index);
                  const draft = cueDrafts[key] ?? draftFromCue(cue);
                  const hasDraft = Boolean(cueDrafts[key]);
                  return (
                    <tr key={`${cue.startMs}-${cue.endMs}-${index}`}>
                      <td>
                        {selectedTrack.sourceBytes ? (
                          <label className="cue-field">
                            <span className="sr-only">Cue {index + 1} start milliseconds</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              disabled={Boolean(busy)}
                              value={draft.startMs}
                              onChange={(event) => setCueDraftValue(selectedTrack, index, cue, "startMs", event.currentTarget.value)}
                            />
                            <small>{formatClock(adjusted.startMs)}</small>
                          </label>
                        ) : formatClock(adjusted.startMs)}
                      </td>
                      <td>
                        {selectedTrack.sourceBytes ? (
                          <label className="cue-field">
                            <span className="sr-only">Cue {index + 1} end milliseconds</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              disabled={Boolean(busy)}
                              value={draft.endMs}
                              onChange={(event) => setCueDraftValue(selectedTrack, index, cue, "endMs", event.currentTarget.value)}
                            />
                            <small>{formatClock(adjusted.endMs)}</small>
                          </label>
                        ) : formatClock(adjusted.endMs)}
                      </td>
                      <td>
                        {selectedTrack.sourceBytes ? (
                          <label className="cue-field cue-text-field">
                            <span className="sr-only">Cue {index + 1} source text</span>
                            <textarea
                              ref={(node) => {
                                cueTextRefs.current[key] = node;
                              }}
                              rows={2}
                              disabled={Boolean(busy)}
                              value={draft.rawText}
                              onChange={(event) => setCueDraftValue(selectedTrack, index, cue, "rawText", event.currentTarget.value)}
                            />
                          </label>
                        ) : cue.text}
                      </td>
                      <td>
                        <div className="cue-actions">
                          <button type="button" className="secondary-button" onClick={() => seek(adjusted.startMs)}>Seek</button>
                          {selectedTrack.sourceBytes ? (
                            <>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={Boolean(busy) || hasDraft}
                                title={hasDraft ? "Save this cue before using it as a drift anchor." : "Capture this cue start against the current reference playhead."}
                                onClick={() => captureDriftAnchor(selectedTrack, cue, "first")}
                              >
                                Anchor 1
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={Boolean(busy) || hasDraft}
                                title={hasDraft ? "Save this cue before using it as a drift anchor." : "Capture this cue start against the current reference playhead."}
                                onClick={() => captureDriftAnchor(selectedTrack, cue, "second")}
                              >
                                Anchor 2
                              </button>
                              <button type="button" disabled={Boolean(busy)} onClick={() => saveCueEdit(selectedTrack, index, cue)}>Save</button>
                              <button type="button" disabled={Boolean(busy)} onClick={() => splitCueAtPlayhead(selectedTrack, index, cue)}>Split at playhead</button>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={Boolean(busy) || index >= selectedTrack.cues.length - 1}
                                onClick={() => mergeCueWithNext(selectedTrack, index, cue)}
                              >
                                Merge next
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="support-panel" aria-labelledby="support-heading">
        <div>
          <p className="eyebrow">Embedded subtitle support</p>
          <h2 id="support-heading">Text tracks are extracted; bitmap tracks stay explicit.</h2>
        </div>
        <p>
          MP4/MOV extraction covers tx3g, WebVTT (wvtt), and TTML (stpp). Matroska/WebM covers UTF-8, WebVTT, ASS/SSA, and USF text tracks. PGS, VobSub, and other bitmap subtitle codecs are reported as unsupported rather than silently discarded.
        </p>
        <p>
          Video inspection runs in a Web Worker and streams only the byte ranges requested by Rust. MP4 metadata reads are capped at 64 MiB, coalesced subtitle-sample reads at 4 MiB, and Matroska subtitle blocks at 16 MiB. No server fallback is used.
        </p>
      </section>
    </div>
  );
}
