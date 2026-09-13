export type TimelineCueEditMode = "move" | "start" | "end";

export type CueTiming = {
  startMs: number;
  endMs: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function pointerDeltaToMilliseconds(
  deltaPixels: number,
  laneWidthPixels: number,
  timelineDurationMs: number,
) {
  if (!Number.isFinite(deltaPixels) || laneWidthPixels <= 0 || timelineDurationMs <= 0) {
    return 0;
  }
  return Math.round((deltaPixels / laneWidthPixels) * timelineDurationMs);
}

export function previewCueTiming(
  timing: CueTiming,
  deltaMs: number,
  mode: TimelineCueEditMode,
  timelineDurationMs: number,
  trackOffsetMs: number,
): CueTiming {
  const startMs = Math.max(0, Math.round(timing.startMs));
  const endMs = Math.max(startMs, Math.round(timing.endMs));
  const delta = Math.round(deltaMs);
  const visibleSourceEnd = Math.max(endMs, Math.round(timelineDurationMs - trackOffsetMs));

  if (mode === "start") {
    return {
      startMs: clamp(startMs + delta, 0, endMs),
      endMs,
    };
  }

  if (mode === "end") {
    return {
      startMs,
      endMs: clamp(endMs + delta, startMs, visibleSourceEnd),
    };
  }

  const minimumDelta = -startMs;
  const maximumDelta = visibleSourceEnd - endMs;
  const appliedDelta = clamp(delta, minimumDelta, maximumDelta);
  return {
    startMs: startMs + appliedDelta,
    endMs: endMs + appliedDelta,
  };
}
