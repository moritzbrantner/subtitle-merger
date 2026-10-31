import { memo, type RefObject } from "react";

import { formatClock } from "../lib/subtitles";
import type { Cue, Track } from "../lib/types";
import {
  cueDraftKey,
  draftFromCue,
  shiftedCue,
  type CueDraft,
} from "../lib/workbench";

type CueAction = (track: Track, cueIndex: number, cue: Cue) => void;

type CueCallbacks = {
  cueTextRefs: RefObject<Record<string, HTMLTextAreaElement | null>>;
  busy: boolean;
  onDraftChange: (
    track: Track,
    cueIndex: number,
    cue: Cue,
    field: keyof CueDraft,
    value: string,
  ) => void;
  onSeek: (milliseconds: number) => void;
  onCaptureAnchor: (track: Track, cue: Cue, anchor: "first" | "second") => void;
  onSave: CueAction;
  onSplit: CueAction;
  onMergeNext: CueAction;
};

type RowProps = CueCallbacks & {
  track: Track;
  cue: Cue;
  index: number;
  cueDraft: CueDraft | undefined;
};

const CueTableRow = memo(function CueTableRow({
  track,
  cue,
  index,
  cueDraft,
  cueTextRefs,
  busy,
  onDraftChange,
  onSeek,
  onCaptureAnchor,
  onSave,
  onSplit,
  onMergeNext,
}: RowProps) {
  const adjusted = shiftedCue(cue, track.offsetMs);
  const key = cueDraftKey(track.id, index);
  const draft = cueDraft ?? draftFromCue(cue);
  const hasDraft = Boolean(cueDraft);
  return (
    <tr>
      <td>
        {track.sourceBytes ? (
          <label className="cue-field">
            <span className="sr-only">Cue {index + 1} start milliseconds</span>
            <input
              type="number"
              min="0"
              step="1"
              disabled={busy}
              value={draft.startMs}
              onChange={(event) => onDraftChange(track, index, cue, "startMs", event.currentTarget.value)}
            />
            <small>{formatClock(adjusted.startMs)}</small>
          </label>
        ) : formatClock(adjusted.startMs)}
      </td>
      <td>
        {track.sourceBytes ? (
          <label className="cue-field">
            <span className="sr-only">Cue {index + 1} end milliseconds</span>
            <input
              type="number"
              min="0"
              step="1"
              disabled={busy}
              value={draft.endMs}
              onChange={(event) => onDraftChange(track, index, cue, "endMs", event.currentTarget.value)}
            />
            <small>{formatClock(adjusted.endMs)}</small>
          </label>
        ) : formatClock(adjusted.endMs)}
      </td>
      <td>
        {track.sourceBytes ? (
          <label className="cue-field cue-text-field">
            <span className="sr-only">Cue {index + 1} source text</span>
            <textarea
              ref={(node) => {
                cueTextRefs.current[key] = node;
              }}
              rows={2}
              disabled={busy}
              value={draft.rawText}
              onChange={(event) => onDraftChange(track, index, cue, "rawText", event.currentTarget.value)}
            />
          </label>
        ) : cue.text}
      </td>
      <td>
        <div className="cue-actions">
          <button type="button" className="secondary-button" onClick={() => onSeek(adjusted.startMs)}>Seek</button>
          {track.sourceBytes ? (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || hasDraft}
                title={hasDraft ? "Save this cue before using it as a drift anchor." : "Capture this cue start against the current reference playhead."}
                onClick={() => onCaptureAnchor(track, cue, "first")}
              >
                Anchor 1
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || hasDraft}
                title={hasDraft ? "Save this cue before using it as a drift anchor." : "Capture this cue start against the current reference playhead."}
                onClick={() => onCaptureAnchor(track, cue, "second")}
              >
                Anchor 2
              </button>
              <button type="button" disabled={busy} onClick={() => onSave(track, index, cue)}>Save</button>
              <button type="button" disabled={busy} onClick={() => onSplit(track, index, cue)}>Split at playhead</button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || index >= track.cues.length - 1}
                onClick={() => onMergeNext(track, index, cue)}
              >
                Merge next
              </button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
});

type Props = CueCallbacks & {
  track: Track;
  cueDrafts: Record<string, CueDraft>;
};

// Memoized so playhead updates skip the table; rows skip keystrokes in other rows.
export const CueTable = memo(function CueTable({
  track,
  cueDrafts,
  ...rowProps
}: Props) {
  return (
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
          {track.cues.map((cue, index) => (
            <CueTableRow
              key={`${cue.startMs}-${cue.endMs}-${index}`}
              track={track}
              cue={cue}
              index={index}
              cueDraft={cueDrafts[cueDraftKey(track.id, index)]}
              {...rowProps}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});
