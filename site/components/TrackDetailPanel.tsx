import type { ReactNode } from "react";

import { DriftCorrectionPanel } from "./DriftCorrectionPanel";
import { SubtitleQualityPanel } from "./SubtitleQualityPanel";
import type { DocumentHistory } from "../lib/document-history";
import type { DriftCorrectionDraft } from "../lib/drift-view";
import type { SubtitleQualityReport, Track } from "../lib/types";
import { shiftedTime, trackOriginLabel } from "../lib/workbench";

type Props = {
  track: Track;
  trackIndex: number;
  trackCount: number;
  history: DocumentHistory | undefined;
  hasCueDrafts: boolean;
  busy: string;
  driftDraft: DriftCorrectionDraft;
  quality: {
    qualityReport: SubtitleQualityReport | undefined;
    qualityError: string;
    qualityBusy: boolean;
  };
  seek: (milliseconds: number) => void;
  onMoveTrack: (trackId: string, direction: -1 | 1) => void;
  onRestoreDocument: (track: Track, direction: "undo" | "redo") => void;
  onDownloadSource: (track: Track) => void;
  onDownloadTrack: (track: Track, format: "srt" | "vtt") => void;
  onRemoveTrack: (trackId: string) => void;
  onOffsetChange: (trackId: string, offsetMs: number) => void;
  onDriftDraftChange: (
    anchor: "first" | "second",
    field: "sourceMs" | "referenceMs",
    value: string,
  ) => void;
  onDriftClear: () => void;
  onApplyDrift: (track: Track) => void;
  children: ReactNode;
};

export function TrackDetailPanel({
  track,
  trackIndex,
  trackCount,
  history,
  hasCueDrafts,
  busy,
  driftDraft,
  quality,
  seek,
  onMoveTrack,
  onRestoreDocument,
  onDownloadSource,
  onDownloadTrack,
  onRemoveTrack,
  onOffsetChange,
  onDriftDraftChange,
  onDriftClear,
  onApplyDrift,
  children,
}: Props) {
  function selectQualityCue(cueIndex: number) {
    const cue = track.cues[cueIndex];
    if (!cue) {
      return;
    }
    seek(shiftedTime(cue.startMs, track.offsetMs));
  }

  return (
    <section className="detail-panel" aria-labelledby="detail-heading">
      <div className="section-heading detail-heading">
        <div>
          <p className="eyebrow">Track detail</p>
          <h2 id="detail-heading">{track.title}</h2>
          <p className="track-meta">
            {trackOriginLabel(track)} · {track.format}
            {track.language !== "und" ? ` · ${track.language}` : ""}
            {track.forced ? " · forced" : ""}
          </p>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={trackIndex <= 0}
            onClick={() => onMoveTrack(track.id, -1)}
          >
            Move up
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={trackIndex < 0 || trackIndex >= trackCount - 1}
            onClick={() => onMoveTrack(track.id, 1)}
          >
            Move down
          </button>
          {track.sourceBytes ? (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(busy) || hasCueDrafts || !history?.undo.length}
                title={hasCueDrafts ? "Save pending cue drafts before undoing accepted edits." : undefined}
                onClick={() => onRestoreDocument(track, "undo")}
              >
                Undo edit
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(busy) || hasCueDrafts || !history?.redo.length}
                title={hasCueDrafts ? "Save pending cue drafts before redoing accepted edits." : undefined}
                onClick={() => onRestoreDocument(track, "redo")}
              >
                Redo edit
              </button>
              <button type="button" onClick={() => onDownloadSource(track)}>Download source</button>
            </>
          ) : null}
          <button type="button" onClick={() => onDownloadTrack(track, "srt")}>Convert to SRT</button>
          <button type="button" onClick={() => onDownloadTrack(track, "vtt")}>Convert to VTT</button>
          <button type="button" className="secondary-button" onClick={() => onRemoveTrack(track.id)}>Remove</button>
        </div>
      </div>

      <label className="offset-control">
        <span>Track offset (milliseconds)</span>
        <input
          type="number"
          step="100"
          value={track.offsetMs}
          onChange={(event) => onOffsetChange(track.id, Number(event.currentTarget.value))}
        />
        <small>Positive values delay this track; negative values move it earlier. Preview plus converted and merged exports use this offset; Download source preserves source-document timing.</small>
      </label>

      <DriftCorrectionPanel
        trackTitle={track.title}
        trackOffsetMs={track.offsetMs}
        sourceAvailable={Boolean(track.sourceBytes)}
        busy={Boolean(busy)}
        hasCueDrafts={hasCueDrafts}
        draft={driftDraft}
        onChange={onDriftDraftChange}
        onClear={onDriftClear}
        onApply={() => onApplyDrift(track)}
      />

      <SubtitleQualityPanel
        trackTitle={track.title}
        sourceAvailable={Boolean(track.sourceBytes)}
        report={quality.qualityReport}
        busy={quality.qualityBusy}
        error={quality.qualityError}
        onSelectCue={selectQualityCue}
      />

      {track.sourceBytes ? (
        <p className="merge-note">
          Cue timing, text, split, merge, timeline timing, and two-anchor drift correction are applied atomically through Rust before replacing this track. Drift anchors capture a cue's accepted source start against the current reference playhead; the whole-track offset stays separate. Drag a cue to move it; drag its edge handles to resize it. Keyboard focus on the cue or handles uses Left/Right for 100 ms and Shift+Left/Right for one second. Timeline editing and drift application are disabled while there are unsaved cue drafts. Split uses the current video playhead and the source-text caret; Merge next includes any unsaved drafts for both cues. Undo/redo keeps accepted source-document states in bounded browser memory and reparses a restored state through Rust. Track offset and track ordering are not part of this source-edit history. For ASS/SSA and marked-up WebVTT, the source-text field intentionally exposes format markup so editing text does not silently discard it.
        </p>
      ) : (
        <p className="merge-note">
          Embedded tracks are read-only in this slice because their extracted source document is not retained yet. They can still be offset, reordered, converted, and merged.
        </p>
      )}

      {children}
    </section>
  );
}
