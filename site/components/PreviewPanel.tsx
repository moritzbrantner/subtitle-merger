import type { Dispatch, RefObject, SetStateAction } from "react";

import { SubtitleSelectionBar } from "./SubtitleSelectionBar";
import { VideoSubtitleCue } from "./VideoSubtitleCue";
import { defaultCuePlacement, type CuePlacement } from "../lib/editor-interaction";
import { formatClock } from "../lib/subtitles";
import type { Cue, Track, VideoInspection } from "../lib/types";
import {
  cueDraftKey,
  selectionMatches,
  type CueSelection,
  type InlineCueEdit,
  type VisibleCue,
} from "../lib/workbench";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoUrl: string;
  inspection: VideoInspection | undefined;
  visibleCues: VisibleCue[];
  cuePlacements: Record<string, CuePlacement>;
  selectedCue: CueSelection | undefined;
  selectedCueContext:
    | (VisibleCue & { placement: CuePlacement })
    | undefined;
  inlineCueEdit: InlineCueEdit | undefined;
  setInlineCueEdit: Dispatch<SetStateAction<InlineCueEdit | undefined>>;
  busy: string;
  onPositionChange: (milliseconds: number) => void;
  onDurationChange: (milliseconds: number) => void;
  onSelectCue: (trackId: string, cueIndex: number) => void;
  onMoveCue: (trackId: string, cueIndex: number, placement: CuePlacement) => void;
  onBeginInlineEdit: (track: Track, cueIndex: number, cue: Cue) => void;
  onCommitInlineEdit: () => Promise<void>;
};

export function PreviewPanel({
  videoRef,
  videoUrl,
  inspection,
  visibleCues,
  cuePlacements,
  selectedCue,
  selectedCueContext,
  inlineCueEdit,
  setInlineCueEdit,
  busy,
  onPositionChange,
  onDurationChange,
  onSelectCue,
  onMoveCue,
  onBeginInlineEdit,
  onCommitInlineEdit,
}: Props) {
  return (
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
              onTimeUpdate={(event) => onPositionChange(event.currentTarget.currentTime * 1000)}
              onLoadedMetadata={(event) => {
                if (Number.isFinite(event.currentTarget.duration)) {
                  onDurationChange(event.currentTarget.duration * 1000);
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
                      onSelect={() => onSelectCue(track.id, cueIndex)}
                      onMove={(placement) => onMoveCue(track.id, cueIndex, placement)}
                      onBeginTextEdit={() => onBeginInlineEdit(track, cueIndex, cue)}
                      onEditTextChange={(rawText) =>
                        setInlineCueEdit((current) =>
                          current && selectionMatches(current, track.id, cueIndex)
                            ? { ...current, rawText }
                            : current,
                        )
                      }
                      onCommitTextEdit={onCommitInlineEdit}
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
            onMoveCue(
              selectedCueContext.track.id,
              selectedCueContext.cueIndex,
              placement,
            )
          }
          onEditText={() =>
            onBeginInlineEdit(
              selectedCueContext.track,
              selectedCueContext.cueIndex,
              selectedCueContext.cue,
            )
          }
        />
      ) : null}
    </section>
  );
}
