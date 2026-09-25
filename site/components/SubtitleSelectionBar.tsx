"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import {
  clampPlacementPercent,
  type CuePlacement,
} from "../lib/editor-interaction";

type PercentInputProps = {
  axis: "X" | "Y";
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
};

function PercentInput({
  axis,
  value,
  disabled,
  onCommit,
}: PercentInputProps) {
  const [draft, setDraft] = useState<string>();
  const cancelRef = useRef(false);

  function commit() {
    if (cancelRef.current) {
      cancelRef.current = false;
      setDraft(undefined);
      return;
    }
    if (draft === undefined || draft.trim() === "") {
      setDraft(undefined);
      return;
    }
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) {
      onCommit(clampPlacementPercent(parsed));
    }
    setDraft(undefined);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRef.current = true;
      event.currentTarget.blur();
    }
  }

  return (
    <label className="subtitle-position-field">
      <span>{axis}</span>
      <input
        type="number"
        min="4"
        max="96"
        step="0.1"
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? String(Number(value.toFixed(2)))}
        onFocus={() => {
          cancelRef.current = false;
          setDraft(String(Number(value.toFixed(2))));
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        aria-label={`Subtitle ${axis} position percent`}
      />
      <small>%</small>
    </label>
  );
}

type Props = {
  trackTitle: string;
  cueIndex: number;
  placement: CuePlacement;
  editable: boolean;
  busy: boolean;
  onPlacementChange: (placement: CuePlacement) => void;
  onEditText: () => void;
};

export function SubtitleSelectionBar({
  trackTitle,
  cueIndex,
  placement,
  editable,
  busy,
  onPlacementChange,
  onEditText,
}: Props) {
  return (
    <div className="subtitle-selection-bar" aria-label="Selected subtitle controls">
      <div className="subtitle-selection-label">
        <strong>{trackTitle}</strong>
        <span>Cue {cueIndex + 1}</span>
      </div>
      <div className="subtitle-position-controls" aria-label="Subtitle position">
        <PercentInput
          axis="X"
          value={placement.xPercent}
          disabled={busy}
          onCommit={(xPercent) => onPlacementChange({ ...placement, xPercent })}
        />
        <PercentInput
          axis="Y"
          value={placement.yPercent}
          disabled={busy}
          onCommit={(yPercent) => onPlacementChange({ ...placement, yPercent })}
        />
      </div>
      <button
        type="button"
        className="secondary-button"
        disabled={busy || !editable}
        title={
          editable
            ? "Edit the selected subtitle text."
            : "This subtitle track does not retain an editable source document."
        }
        onClick={onEditText}
      >
        Edit text
      </button>
    </div>
  );
}
