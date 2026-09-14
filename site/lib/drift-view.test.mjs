import { describe, expect, test } from "bun:test";

import {
  capturedDriftAnchor,
  driftCorrectionRequest,
  emptyDriftCorrectionDraft,
} from "./drift-view.ts";

describe("drift correction presentation helpers", () => {
  test("keeps the whole-track offset separate from expected document timing", () => {
    const request = driftCorrectionRequest(
      {
        first: { sourceMs: "1000", referenceMs: "1400" },
        second: { sourceMs: "9000", referenceMs: "10400" },
      },
      200,
    );

    expect(request).toEqual({
      sourceStartMs: 1000,
      expectedStartMs: 1200,
      sourceEndMs: 9000,
      expectedEndMs: 10200,
    });
  });

  test("captures integer cue/playhead values without drift arithmetic", () => {
    expect(capturedDriftAnchor(1234.9, 2345.9)).toEqual({
      sourceMs: "1234",
      referenceMs: "2345",
    });
  });

  test("rejects incomplete and offset-invalid requests before WASM framing", () => {
    expect(() => driftCorrectionRequest(emptyDriftCorrectionDraft(), 0)).toThrow("required");
    expect(() => driftCorrectionRequest({
      first: { sourceMs: "1000", referenceMs: "50" },
      second: { sourceMs: "2000", referenceMs: "100" },
    }, 200)).toThrow("before zero");
  });
});
