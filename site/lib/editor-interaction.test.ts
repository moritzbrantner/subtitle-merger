import { describe, expect, test } from "bun:test";

import {
  clampCuePlacement,
  defaultCuePlacement,
  timelineMillisecondsFromPointer,
} from "./editor-interaction";

describe("direct subtitle editor interactions", () => {
  test("keeps cue placement inside the editable video area", () => {
    expect(clampCuePlacement({ xPercent: -30, yPercent: 120 })).toEqual({
      xPercent: 4,
      yPercent: 96,
    });
  });

  test("gives translation tracks distinct default vertical positions", () => {
    expect(defaultCuePlacement(0)).toEqual({ xPercent: 50, yPercent: 82 });
    expect(defaultCuePlacement(1)).toEqual({ xPercent: 50, yPercent: 75 });
    expect(defaultCuePlacement(20)).toEqual({ xPercent: 50, yPercent: 4 });
  });

  test("maps pointer position to a clamped timeline playhead", () => {
    expect(timelineMillisecondsFromPointer(150, 100, 200, 10_000)).toBe(2_500);
    expect(timelineMillisecondsFromPointer(50, 100, 200, 10_000)).toBe(0);
    expect(timelineMillisecondsFromPointer(350, 100, 200, 10_000)).toBe(10_000);
  });
});
