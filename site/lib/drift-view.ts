import type { DriftCorrection } from "./wasm";

export type DriftAnchorDraft = {
  sourceMs: string;
  referenceMs: string;
};

export type DriftCorrectionDraft = {
  first: DriftAnchorDraft;
  second: DriftAnchorDraft;
};

export function emptyDriftCorrectionDraft(): DriftCorrectionDraft {
  return {
    first: { sourceMs: "", referenceMs: "" },
    second: { sourceMs: "", referenceMs: "" },
  };
}

export function capturedDriftAnchor(
  sourceMs: number,
  referenceMs: number,
): DriftAnchorDraft {
  return {
    sourceMs: String(Math.trunc(sourceMs)),
    referenceMs: String(Math.trunc(referenceMs)),
  };
}

function parseMilliseconds(value: string, label: string): number {
  if (value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer number of milliseconds.`);
  }
  return parsed;
}

export function driftCorrectionRequest(
  draft: DriftCorrectionDraft,
  trackOffsetMs: number,
): DriftCorrection {
  if (!Number.isSafeInteger(trackOffsetMs)) {
    throw new Error("Track offset must be an integer number of milliseconds.");
  }

  const sourceStartMs = parseMilliseconds(draft.first.sourceMs, "First subtitle anchor");
  const referenceStartMs = parseMilliseconds(draft.first.referenceMs, "First reference anchor");
  const sourceEndMs = parseMilliseconds(draft.second.sourceMs, "Second subtitle anchor");
  const referenceEndMs = parseMilliseconds(draft.second.referenceMs, "Second reference anchor");
  const expectedStartMs = referenceStartMs - trackOffsetMs;
  const expectedEndMs = referenceEndMs - trackOffsetMs;

  if (expectedStartMs < 0 || expectedEndMs < 0) {
    throw new Error(
      "The current track offset would move an expected source-document anchor before zero. Adjust the offset or anchors first.",
    );
  }

  return {
    sourceStartMs,
    expectedStartMs,
    sourceEndMs,
    expectedEndMs,
  };
}
