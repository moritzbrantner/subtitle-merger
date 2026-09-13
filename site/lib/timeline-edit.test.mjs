import { expect, test } from "bun:test";

import {
  pointerDeltaToMilliseconds,
  previewCueTiming,
} from "./timeline-edit.ts";

test("maps pointer movement to timeline milliseconds", () => {
  expect(pointerDeltaToMilliseconds(50, 1000, 20_000)).toBe(1000);
  expect(pointerDeltaToMilliseconds(-25, 1000, 20_000)).toBe(-500);
  expect(pointerDeltaToMilliseconds(20, 0, 20_000)).toBe(0);
});

test("moves a cue without changing its duration and clamps to the timeline", () => {
  expect(previewCueTiming({ startMs: 1000, endMs: 3000 }, 750, "move", 10_000, 0)).toEqual({
    startMs: 1750,
    endMs: 3750,
  });
  expect(previewCueTiming({ startMs: 1000, endMs: 3000 }, -5000, "move", 10_000, 0)).toEqual({
    startMs: 0,
    endMs: 2000,
  });
  expect(previewCueTiming({ startMs: 7000, endMs: 9000 }, 5000, "move", 10_000, 0)).toEqual({
    startMs: 8000,
    endMs: 10_000,
  });
});

test("resizes start and end independently with track-offset-aware bounds", () => {
  expect(previewCueTiming({ startMs: 1000, endMs: 3000 }, 700, "start", 10_000, 500)).toEqual({
    startMs: 1700,
    endMs: 3000,
  });
  expect(previewCueTiming({ startMs: 1000, endMs: 3000 }, -5000, "start", 10_000, 500)).toEqual({
    startMs: 0,
    endMs: 3000,
  });
  expect(previewCueTiming({ startMs: 1000, endMs: 3000 }, 20_000, "end", 10_000, 500)).toEqual({
    startMs: 1000,
    endMs: 9500,
  });
});
