import { describe, expect, test } from "bun:test";

import { qualityCueIndexes, qualityDiagnosticCueLabel } from "./quality-view.ts";

describe("quality diagnostic presentation helpers", () => {
  test("highlights both cues for relationship diagnostics", () => {
    const indexes = qualityCueIndexes([
      {
        code: "overlap",
        severity: "warning",
        cueIndex: 2,
        relatedCueIndex: 3,
        message: "overlap",
      },
      {
        code: "line-too-long",
        severity: "warning",
        cueIndex: 7,
        relatedCueIndex: null,
        message: "line",
      },
    ]);

    expect([...indexes]).toEqual([2, 3, 7]);
  });

  test("uses one-based cue labels without interpreting diagnostic semantics", () => {
    expect(
      qualityDiagnosticCueLabel({
        code: "gap-too-short",
        severity: "warning",
        cueIndex: 0,
        relatedCueIndex: 1,
        message: "gap",
      }),
    ).toBe("Cue 1 ↔ Cue 2");
  });
});
