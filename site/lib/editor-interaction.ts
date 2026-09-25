export type CuePlacement = {
  xPercent: number;
  yPercent: number;
};

const minPlacementPercent = 4;
const maxPlacementPercent = 96;

export function clampPlacementPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.min(maxPlacementPercent, Math.max(minPlacementPercent, value));
}

export function clampCuePlacement(placement: CuePlacement): CuePlacement {
  return {
    xPercent: clampPlacementPercent(placement.xPercent),
    yPercent: clampPlacementPercent(placement.yPercent),
  };
}

export function defaultCuePlacement(trackIndex: number): CuePlacement {
  return clampCuePlacement({
    xPercent: 50,
    yPercent: 82 - Math.max(0, trackIndex) * 7,
  });
}

export function timelineMillisecondsFromPointer(
  clientX: number,
  left: number,
  width: number,
  durationMs: number,
): number {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, (clientX - left) / width));
  return Math.round(ratio * durationMs);
}
