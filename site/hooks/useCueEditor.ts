import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { useStableCallback } from "./useStableCallback";
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
  clampCuePlacement,
  defaultCuePlacement,
  type CuePlacement,
} from "../lib/editor-interaction";
import { sourceExtension } from "../lib/track-download";
import type { Cue, Track } from "../lib/types";
import {
  correctSubtitleDrift,
  editSubtitleCue,
  mergeSubtitleCues,
  parseSubtitle,
  splitSubtitleCue,
  type CueEditResult,
} from "../lib/wasm";
import {
  cueDraftKey,
  draftFromCue,
  shiftedTime,
  type CueDraft,
  type CueSelection,
  type InlineCueEdit,
} from "../lib/workbench";

type CueEditorOptions = {
  tracks: Track[];
  setTracks: Dispatch<SetStateAction<Track[]>>;
  selectedTrack: Track | undefined;
  setSelectedTrackId: Dispatch<SetStateAction<string>>;
  setBusy: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  videoRef: RefObject<HTMLVideoElement | null>;
  positionMs: number;
  seek: (milliseconds: number) => void;
};

/**
 * Cue-level browser state (selection, drafts, placements, inline edit, drift
 * anchors, accepted-document history) and the Rust-backed document edits that
 * replace a track's source.
 */
export function useCueEditor({
  tracks,
  setTracks,
  selectedTrack,
  setSelectedTrackId,
  setBusy,
  setError,
  videoRef,
  positionMs,
  seek,
}: CueEditorOptions) {
  const cueEditInFlightRef = useRef(false);
  const cueTextRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [selectedCue, setSelectedCue] = useState<CueSelection>();
  const [inlineCueEdit, setInlineCueEdit] = useState<InlineCueEdit>();
  const [cuePlacements, setCuePlacements] = useState<Record<string, CuePlacement>>({});
  const [cueDrafts, setCueDrafts] = useState<Record<string, CueDraft>>({});
  const [documentHistory, setDocumentHistory] = useState<Record<string, DocumentHistory>>({});
  const [driftDraft, setDriftDraft] = useState<DriftCorrectionDraft>(emptyDriftCorrectionDraft);

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

  function clearCueBrowserState(trackIds: Set<string>) {
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
    for (const key of Object.keys(cueTextRefs.current)) {
      if (ids.some((trackId) => key.startsWith(`${trackId}:`))) {
        delete cueTextRefs.current[key];
      }
    }
  }

  function clearTrackBrowserState(trackIds: Set<string>) {
    clearCueBrowserState(trackIds);
    setDocumentHistory((current) => {
      const next = { ...current };
      for (const trackId of trackIds) {
        delete next[trackId];
      }
      return next;
    });
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
      clearCueBrowserState(new Set([track.id]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${direction} operation failed.`);
    } finally {
      cueEditInFlightRef.current = false;
      setBusy("");
    }
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
    const adjustedStartMs = shiftedTime(cue.startMs, track.offsetMs);
    const adjustedEndMs = shiftedTime(cue.endMs, track.offsetMs);
    videoRef.current?.pause();
    if (positionMs < adjustedStartMs || positionMs >= adjustedEndMs) {
      seek(adjustedStartMs);
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

  return {
    selectedCue,
    inlineCueEdit,
    setInlineCueEdit,
    cuePlacements,
    cueDrafts,
    cueTextRefs,
    driftDraft,
    setDriftDraft,
    selectedHistory,
    selectedTrackHasDrafts,
    selectedCueContext,
    clearTrackBrowserState,
    setSelectedCue,
    setDriftDraftValue,
    applyDriftCorrectionToTrack,
    restoreAcceptedDocument,
    setCuePlacement,
    beginInlineCueEdit,
    commitInlineCueEdit,
    // Identity-stable because they are passed to memoized per-cue components.
    selectCue: useStableCallback(selectCue),
    setCueDraftValue: useStableCallback(setCueDraftValue),
    saveCueEdit: useStableCallback(saveCueEdit),
    commitTimelineCueTiming: useStableCallback(commitTimelineCueTiming),
    splitCueAtPlayhead: useStableCallback(splitCueAtPlayhead),
    mergeCueWithNext: useStableCallback(mergeCueWithNext),
    captureDriftAnchor: useStableCallback(captureDriftAnchor),
  };
}
