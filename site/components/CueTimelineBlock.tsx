"use client";

import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

import { formatClock } from "../lib/subtitles";
import {
  pointerDeltaToMilliseconds,
  previewCueTiming,
  type CueTiming,
  type TimelineCueEditMode,
} from "../lib/timeline-edit";
import type { Cue } from "../lib/types";

type Props = {
  cue: Cue;
  cueIndex: number;
  trackTitle: string;
  trackOffsetMs: number;
  timelineDurationMs: number;
  editable: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onSeek: (milliseconds: number) => void;
  onCommitTiming: (startMs: number, endMs: number) => Promise<boolean>;
};

type Gesture = {
  pointerId: number;
  mode: TimelineCueEditMode;
  startX: number;
  laneWidth: number;
  timing: CueTiming;
};

function shiftedTime(milliseconds: number, offsetMs: number) {
  return Math.max(0, milliseconds + offsetMs);
}

export function CueTimelineBlock({
  cue,
  cueIndex,
  trackTitle,
  trackOffsetMs,
  timelineDurationMs,
  editable,
  selected,
  busy,
  onSelect,
  onSeek,
  onCommitTiming,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | undefined>(undefined);
  const previewRef = useRef<CueTiming | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<CueTiming>();
  const [committing, setCommitting] = useState(false);

  const timing = preview ?? { startMs: cue.startMs, endMs: cue.endMs };
  const adjustedStartMs = shiftedTime(timing.startMs, trackOffsetMs);
  const adjustedEndMs = Math.max(adjustedStartMs, shiftedTime(timing.endMs, trackOffsetMs));
  const left = Math.min(100, (adjustedStartMs / timelineDurationMs) * 100);
  const width = Math.max(
    0.16,
    Math.min(100 - left, ((adjustedEndMs - adjustedStartMs) / timelineDurationMs) * 100),
  );
  const interactionDisabled = busy || committing;
  const canEdit = editable && !interactionDisabled;

  function setPreviewTiming(value: CueTiming | undefined) {
    previewRef.current = value;
    setPreview(value);
  }

  function startGesture(event: PointerEvent<HTMLButtonElement>, mode: TimelineCueEditMode) {
    event.stopPropagation();
    onSelect();
    if (!canEdit) {
      return;
    }
    const lane = shellRef.current?.parentElement;
    const laneWidth = lane?.getBoundingClientRect().width ?? 0;
    if (laneWidth <= 0) {
      return;
    }
    const current = previewRef.current ?? { startMs: cue.startMs, endMs: cue.endMs };
    gestureRef.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      laneWidth,
      timing: current,
    };
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (mode !== "move") {
      event.stopPropagation();
    }
  }

  function moveGesture(event: PointerEvent<HTMLButtonElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    const deltaMs = pointerDeltaToMilliseconds(
      event.clientX - gesture.startX,
      gesture.laneWidth,
      timelineDurationMs,
    );
    const next = previewCueTiming(
      gesture.timing,
      deltaMs,
      gesture.mode,
      timelineDurationMs,
      trackOffsetMs,
    );
    if (
      next.startMs !== gesture.timing.startMs
      || next.endMs !== gesture.timing.endMs
    ) {
      suppressClickRef.current = true;
    }
    setPreviewTiming(next);
    event.preventDefault();
  }

  async function commitTiming(next: CueTiming) {
    if (next.startMs === cue.startMs && next.endMs === cue.endMs) {
      setPreviewTiming(undefined);
      return;
    }
    setCommitting(true);
    try {
      await onCommitTiming(next.startMs, next.endMs);
    } finally {
      setPreviewTiming(undefined);
      setCommitting(false);
    }
  }

  function finishGesture(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    gestureRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled) {
      setPreviewTiming(undefined);
      return;
    }
    const next = previewRef.current;
    if (next) {
      void commitTiming(next);
    }
  }

  function keyboardEdit(event: KeyboardEvent<HTMLButtonElement>, mode: TimelineCueEditMode) {
    if (!canEdit || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 1000 : 100;
    const deltaMs = event.key === "ArrowLeft" ? -step : step;
    const next = previewCueTiming(
      { startMs: cue.startMs, endMs: cue.endMs },
      deltaMs,
      mode,
      timelineDurationMs,
      trackOffsetMs,
    );
    void commitTiming(next);
  }

  function handleCueClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      return;
    }
    onSelect();
    onSeek(adjustedStartMs);
  }

  return (
    <div
      ref={shellRef}
      className={`cue-block-shell${editable ? " is-editable" : ""}${selected ? " is-selected" : ""}${preview ? " is-previewing" : ""}`}
      data-selected={selected ? "true" : "false"}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      <button
        className="cue-block"
        type="button"
        disabled={interactionDisabled}
        title={`${formatClock(adjustedStartMs)} — ${cue.text}${editable ? " · Drag or use arrow keys to move" : ""}`}
        aria-label={`${trackTitle}, cue ${cueIndex + 1}: seek to ${formatClock(adjustedStartMs)}${editable ? "; drag or use arrow keys to move timing" : ""}`}
        aria-pressed={selected}
        onClick={handleCueClick}
        onKeyDown={(event) => keyboardEdit(event, "move")}
        onPointerDown={(event) => startGesture(event, "move")}
        onPointerMove={moveGesture}
        onPointerUp={finishGesture}
        onPointerCancel={(event) => finishGesture(event, true)}
      />
      {editable ? (
        <>
          <button
            className="cue-resize-handle cue-resize-start"
            type="button"
            disabled={interactionDisabled}
            aria-label={`${trackTitle}, cue ${cueIndex + 1}: adjust start; arrow keys move by 100 milliseconds, Shift by one second`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => keyboardEdit(event, "start")}
            onPointerDown={(event) => startGesture(event, "start")}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={(event) => finishGesture(event, true)}
          />
          <button
            className="cue-resize-handle cue-resize-end"
            type="button"
            disabled={interactionDisabled}
            aria-label={`${trackTitle}, cue ${cueIndex + 1}: adjust end; arrow keys move by 100 milliseconds, Shift by one second`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => keyboardEdit(event, "end")}
            onPointerDown={(event) => startGesture(event, "end")}
            onPointerMove={moveGesture}
            onPointerUp={finishGesture}
            onPointerCancel={(event) => finishGesture(event, true)}
          />
        </>
      ) : null}
    </div>
  );
}
