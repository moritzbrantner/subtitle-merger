"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import { CueTable } from "./CueTable";
import { ImportPanel } from "./ImportPanel";
import { MergePanel } from "./MergePanel";
import { PreviewPanel } from "./PreviewPanel";
import { SubtitleTimeline } from "./SubtitleTimeline";
import { SupportPanel } from "./SupportPanel";
import { TrackDetailPanel } from "./TrackDetailPanel";
import { useBrowserTranscriptionSupport } from "../hooks/useBrowserTranscriptionSupport";
import { useCueEditor } from "../hooks/useCueEditor";
import { useStableCallback } from "../hooks/useStableCallback";
import { useSubtitleQuality } from "../hooks/useSubtitleQuality";
import { emptyDriftCorrectionDraft } from "../lib/drift-view";
import { inferTrackTitle } from "../lib/subtitles";
import {
  downloadName,
  sourceExtension,
  sourceMimeType,
  triggerByteDownload,
  triggerDownload,
} from "../lib/track-download";
import type { Track, VideoInspection } from "../lib/types";
import { generatedSubtitleTrack } from "../lib/browser-generation";
import { transcribeReferenceVideo } from "../lib/browser-transcription";
import {
  inspectVideo,
  mergeTracks,
  parseSubtitle,
  type MergeFormat,
} from "../lib/wasm";
import {
  fileTrackId,
  formatByteCount,
  trackEnd,
  visibleCuesAt,
} from "../lib/workbench";

export function SubtitleWorkbench() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  const [videoFile, setVideoFile] = useState<File>();
  const [videoUrl, setVideoUrl] = useState("");
  const [inspection, setInspection] = useState<VideoInspection>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [positionMs, setPositionMs] = useState(0);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
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

  const {
    browserTranscriptionSupport,
    browserTranscriptionModelId,
    setBrowserTranscriptionModelId,
    selectedBrowserTranscriptionModel,
  } = useBrowserTranscriptionSupport();

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

  const seek = useStableCallback((milliseconds: number) => {
    const bounded = Math.min(durationMs, Math.max(0, milliseconds));
    setPositionMs(bounded);
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = bounded / 1000;
  });

  const quality = useSubtitleQuality(selectedTrack);
  const editor = useCueEditor({
    tracks,
    setTracks,
    selectedTrack,
    setSelectedTrackId,
    setBusy,
    setError,
    videoRef,
    positionMs,
    seek,
  });
  const {
    selectedCue,
    inlineCueEdit,
    cueDrafts,
    clearTrackBrowserState,
  } = editor;

  const visibleCues = useMemo(
    () => visibleCuesAt(tracks, positionMs, inlineCueEdit),
    [inlineCueEdit, positionMs, tracks],
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
    const removedTrackIds = new Set(
      tracks
        .filter((track) => track.origin !== "file")
        .map((track) => track.id),
    );
    if (removedTrackIds.size > 0) {
      clearTrackBrowserState(removedTrackIds);
    }
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
      || !selectedBrowserTranscriptionModel
      || generatingSubtitles
    ) {
      return;
    }

    const sourceVideo = videoFile;
    setGeneratingSubtitles(true);
    setBusy("Preparing browser transcription…");
    setError("");

    try {
      const transcript = await transcribeReferenceVideo(
        sourceVideo,
        selectedBrowserTranscriptionModel.id,
        (progress) => {
          if (progress.message) {
            setBusy(progress.message);
          }
        },
      );
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

  function handleGenerateSubtitlesClick() {
    handleGenerateSubtitles().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : "Browser subtitle generation failed.",
      );
    });
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

  function selectTrack(id: string) {
    setSelectedTrackId(id);
    editor.setSelectedCue((current) =>
      current?.trackId === id ? current : undefined,
    );
    editor.setInlineCueEdit((current) =>
      current?.trackId === id ? current : undefined,
    );
  }

  function removeTrack(id: string) {
    setTracks((current) => current.filter((track) => track.id !== id));
    clearTrackBrowserState(new Set([id]));
    if (selectedTrackId === id) {
      setSelectedTrackId("");
    }
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
      <ImportPanel
        videoFile={videoFile}
        busy={busy}
        error={error}
        warnings={warnings}
        generatingSubtitles={generatingSubtitles}
        browserTranscriptionSupport={browserTranscriptionSupport}
        browserTranscriptionModelId={browserTranscriptionModelId}
        selectedBrowserTranscriptionModel={selectedBrowserTranscriptionModel}
        onBrowserTranscriptionModelChange={setBrowserTranscriptionModelId}
        onVideoChange={handleVideoChange}
        onSubtitleChange={handleSubtitleChange}
        onGenerateSubtitles={handleGenerateSubtitlesClick}
      />

      <div className="video-editor-stack">
        <PreviewPanel
          videoRef={videoRef}
          videoUrl={videoUrl}
          inspection={inspection}
          visibleCues={visibleCues}
          cuePlacements={editor.cuePlacements}
          selectedCue={selectedCue}
          selectedCueContext={editor.selectedCueContext}
          inlineCueEdit={inlineCueEdit}
          setInlineCueEdit={editor.setInlineCueEdit}
          busy={busy}
          onPositionChange={setPositionMs}
          onDurationChange={setVideoDurationMs}
          onSelectCue={editor.selectCue}
          onMoveCue={editor.setCuePlacement}
          onBeginInlineEdit={editor.beginInlineCueEdit}
          onCommitInlineEdit={editor.commitInlineCueEdit}
        />

        <SubtitleTimeline
          tracks={tracks}
          selectedTrackId={selectedTrack?.id}
          positionMs={positionMs}
          durationMs={durationMs}
          cueDrafts={cueDrafts}
          selectedCue={selectedCue}
          busy={busy}
          seek={seek}
          onToggleTrack={toggleTrack}
          onSelectTrack={selectTrack}
          onSelectCue={editor.selectCue}
          onCommitTiming={editor.commitTimelineCueTiming}
        />
      </div>

      {tracks.length > 0 ? <MergePanel onDownload={downloadMerged} /> : null}

      {selectedTrack ? (
        <TrackDetailPanel
          track={selectedTrack}
          trackIndex={selectedTrackIndex}
          trackCount={tracks.length}
          history={editor.selectedHistory}
          hasCueDrafts={editor.selectedTrackHasDrafts}
          busy={busy}
          driftDraft={editor.driftDraft}
          quality={quality}
          seek={seek}
          onMoveTrack={moveTrack}
          onRestoreDocument={editor.restoreAcceptedDocument}
          onDownloadSource={downloadSourceTrack}
          onDownloadTrack={downloadTrack}
          onRemoveTrack={removeTrack}
          onOffsetChange={setTrackOffset}
          onDriftDraftChange={editor.setDriftDraftValue}
          onDriftClear={() => editor.setDriftDraft(emptyDriftCorrectionDraft())}
          onApplyDrift={editor.applyDriftCorrectionToTrack}
        >
          <CueTable
            track={selectedTrack}
            cueDrafts={cueDrafts}
            cueTextRefs={editor.cueTextRefs}
            busy={Boolean(busy)}
            onDraftChange={editor.setCueDraftValue}
            onSeek={seek}
            onCaptureAnchor={editor.captureDriftAnchor}
            onSave={editor.saveCueEdit}
            onSplit={editor.splitCueAtPlayhead}
            onMergeNext={editor.mergeCueWithNext}
          />
        </TrackDetailPanel>
      ) : null}

      <SupportPanel />
    </div>
  );
}
