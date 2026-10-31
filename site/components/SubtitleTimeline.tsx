import {
  memo,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { CueTimelineBlock } from "./CueTimelineBlock";
import { timelineMillisecondsFromPointer } from "../lib/editor-interaction";
import { formatClock } from "../lib/subtitles";
import type { Cue, Track } from "../lib/types";
import {
  cueDraftKey,
  selectionMatches,
  type CueDraft,
  type CueSelection,
} from "../lib/workbench";

type TrackCueBlocksProps = {
  track: Track;
  timelineDurationMs: number;
  cueDrafts: Record<string, CueDraft>;
  selectedCue: CueSelection | undefined;
  busy: boolean;
  onSelectCue: (trackId: string, cueIndex: number) => void;
  onSeek: (milliseconds: number) => void;
  onCommitTiming: (
    track: Track,
    cueIndex: number,
    cue: Cue,
    startMs: number,
    endMs: number,
  ) => Promise<boolean>;
};

// Memoized so playhead updates, which only move the lane's playhead, skip every cue.
const TrackCueBlocks = memo(function TrackCueBlocks({
  track,
  timelineDurationMs,
  cueDrafts,
  selectedCue,
  busy,
  onSelectCue,
  onSeek,
  onCommitTiming,
}: TrackCueBlocksProps) {
  return (
    <>
      {track.cues.map((cue, index) => (
        <CueTimelineBlock
          key={`${cue.startMs}-${cue.endMs}-${index}`}
          track={track}
          cue={cue}
          cueIndex={index}
          timelineDurationMs={timelineDurationMs}
          editable={Boolean(track.sourceBytes) && !cueDrafts[cueDraftKey(track.id, index)]}
          selected={selectionMatches(selectedCue, track.id, index)}
          busy={busy}
          onSelect={onSelectCue}
          onSeek={onSeek}
          onCommitTiming={onCommitTiming}
        />
      ))}
    </>
  );
});

type Props = {
  tracks: Track[];
  selectedTrackId: string | undefined;
  positionMs: number;
  durationMs: number;
  cueDrafts: Record<string, CueDraft>;
  selectedCue: CueSelection | undefined;
  busy: string;
  seek: (milliseconds: number) => void;
  onToggleTrack: (trackId: string) => void;
  onSelectTrack: (trackId: string) => void;
  onSelectCue: TrackCueBlocksProps["onSelectCue"];
  onCommitTiming: TrackCueBlocksProps["onCommitTiming"];
};

export function SubtitleTimeline({
  tracks,
  selectedTrackId,
  positionMs,
  durationMs,
  cueDrafts,
  selectedCue,
  busy,
  seek,
  onToggleTrack,
  onSelectTrack,
  onSelectCue,
  onCommitTiming,
}: Props) {
  const timelineScrubPointerRef = useRef<number | undefined>(undefined);

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

  return (
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
              <div className={`track-label${selectedTrackId === track.id ? " is-selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={track.enabled}
                  aria-label={`Enable ${track.title}`}
                  onChange={() => onToggleTrack(track.id)}
                />
                <button
                  type="button"
                  className="track-select-button"
                  aria-pressed={selectedTrackId === track.id}
                  onClick={() => onSelectTrack(track.id)}
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
                <TrackCueBlocks
                  track={track}
                  timelineDurationMs={durationMs}
                  cueDrafts={cueDrafts}
                  selectedCue={selectedCue}
                  busy={Boolean(busy)}
                  onSelectCue={onSelectCue}
                  onSeek={seek}
                  onCommitTiming={onCommitTiming}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
