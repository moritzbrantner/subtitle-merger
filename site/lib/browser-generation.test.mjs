import { describe, expect, test } from "bun:test";

import { generatedSubtitleTrack } from "./browser-generation.ts";

const video = {
  name: "example.video.mp4",
  size: 42,
  lastModified: 17,
};

describe("browser subtitle generation", () => {
  test("converts timed browser transcription segments into an editable generated track", () => {
    const track = generatedSubtitleTrack(
      {
        language: "de",
        segments: [
          { startSeconds: 0.125, endSeconds: 1.75, text: "  Hallo  " },
          { startSeconds: 2, endSeconds: 3.3336, text: "Welt" },
        ],
      },
      video,
    );

    expect(track).toMatchObject({
      id: "generated-example.video.mp4-42-17",
      title: "Generated",
      language: "de",
      origin: "generated",
      format: "srt",
      filename: "example.video.generated.srt",
    });
    expect(track.cues).toEqual([
      { startMs: 125, endMs: 1750, text: "Hallo", rawText: "Hallo" },
      { startMs: 2000, endMs: 3334, text: "Welt", rawText: "Welt" },
    ]);
  });

  test("fails closed instead of inventing timing for untimed transcription output", () => {
    expect(() =>
      generatedSubtitleTrack(
        {
          segments: [{ startSeconds: null, endSeconds: 1, text: "Untimed" }],
        },
        video,
      ),
    ).toThrow("valid start time");
  });

  test("rejects empty generated subtitle output", () => {
    expect(() =>
      generatedSubtitleTrack(
        {
          segments: [{ startSeconds: 0, endSeconds: 1, text: "   " }],
        },
        video,
      ),
    ).toThrow("timed subtitle segments");
  });
});
