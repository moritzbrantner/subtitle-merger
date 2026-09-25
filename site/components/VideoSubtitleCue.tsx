"use client";

import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  clampCuePlacement,
  type CuePlacement,
} from "../lib/editor-interaction";

type Props = {
  trackId: string;
  trackTitle: string;
  cueIndex: number;
  text: string;
  placement: CuePlacement;
  selected: boolean;
  editable: boolean;
  editing: boolean;
  editText: string;
  busy: boolean;
  onSelect: () => void;
  onMove: (placement: CuePlacement) => void;
  onBeginTextEdit: () => void;
  onEditTextChange: (value: string) => void;
  onCommitTextEdit: () => Promise<void>;
  onCancelTextEdit: () => void;
};

type DragGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  placement: CuePlacement;
};

export function VideoSubtitleCue({
  trackId,
  trackTitle,
  cueIndex,
  text,
  placement,
  selected,
  editable,
  editing,
  editText,
  busy,
  onSelect,
  onMove,
  onBeginTextEdit,
  onEditTextChange,
  onCommitTextEdit,
  onCancelTextEdit,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragGesture | undefined>(undefined);
  const previewRef = useRef<CuePlacement | undefined>(undefined);
  const [preview, setPreview] = useState<CuePlacement>();
  const displayedPlacement = preview ?? placement;

  function setPreviewPlacement(value: CuePlacement | undefined) {
    previewRef.current = value;
    setPreview(value);
  }

  function beginDrag(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onSelect();
    if (busy || event.button !== 0) {
      return;
    }

    const stage = shellRef.current?.parentElement;
    const bounds = stage?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: bounds.width,
      height: bounds.height,
      placement,
    };
    setPreviewPlacement(placement);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const next = clampCuePlacement({
      xPercent:
        gesture.placement.xPercent
        + ((event.clientX - gesture.startX) / gesture.width) * 100,
      yPercent:
        gesture.placement.yPercent
        + ((event.clientY - gesture.startY) / gesture.height) * 100,
    });
    setPreviewPlacement(next);
    event.preventDefault();
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const next = previewRef.current;
    setPreviewPlacement(undefined);
    if (!cancelled && next) {
      onMove(next);
    }
  }

  function handleKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 5 : 1;
    let next: CuePlacement | undefined;

    switch (event.key) {
      case "ArrowLeft":
        next = { ...placement, xPercent: placement.xPercent - step };
        break;
      case "ArrowRight":
        next = { ...placement, xPercent: placement.xPercent + step };
        break;
      case "ArrowUp":
        next = { ...placement, yPercent: placement.yPercent - step };
        break;
      case "ArrowDown":
        next = { ...placement, yPercent: placement.yPercent + step };
        break;
      case "Enter":
      case "F2":
        if (editable) {
          event.preventDefault();
          onBeginTextEdit();
        }
        return;
      default:
        return;
    }

    event.preventDefault();
    onSelect();
    onMove(clampCuePlacement(next));
  }

  return (
    <div
      ref={shellRef}
      className={`video-subtitle-cue-shell${selected ? " is-selected" : ""}${editing ? " is-editing" : ""}`}
      style={{
        left: `${displayedPlacement.xPercent}%`,
        top: `${displayedPlacement.yPercent}%`,
      }}
      data-testid="video-subtitle-cue"
      data-track-id={trackId}
      data-cue-index={cueIndex}
      data-selected={selected ? "true" : "false"}
      data-position-x={displayedPlacement.xPercent.toFixed(2)}
      data-position-y={displayedPlacement.yPercent.toFixed(2)}
    >
      {editing ? (
        <textarea
          className="video-subtitle-text-editor"
          aria-label={`Edit ${trackTitle}, cue ${cueIndex + 1}`}
          autoFocus
          disabled={busy}
          rows={Math.max(2, Math.min(5, editText.split("\n").length))}
          value={editText}
          onChange={(event) => onEditTextChange(event.currentTarget.value)}
          onBlur={() => void onCommitTextEdit()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancelTextEdit();
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          className="video-subtitle-cue"
          type="button"
          disabled={busy}
          aria-pressed={selected}
          aria-label={`${trackTitle}, cue ${cueIndex + 1}: select subtitle; drag or use arrow keys to move; double-click or press Enter to edit text`}
          onClick={onSelect}
          onDoubleClick={() => {
            onSelect();
            if (editable) {
              onBeginTextEdit();
            }
          }}
          onKeyDown={handleKeyboard}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={(event) => finishDrag(event, true)}
        >
          {text}
        </button>
      )}
    </div>
  );
}
