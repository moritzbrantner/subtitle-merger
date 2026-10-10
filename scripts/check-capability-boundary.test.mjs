import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cargoViolations, checkRepository, packageViolations } from "./check-capability-boundary.mjs";

describe("capability boundary", () => {
  test("the repository has no direct ASR/model-runtime dependencies", () => {
    expect(checkRepository(resolve(import.meta.dirname, ".."))).toEqual([]);
  });

  test("native-whisperx is the allowed generation dependency", () => {
    expect(cargoViolations("backend/Cargo.toml", {
      dependencies: { "native-whisperx": { git: "https://github.com/moritzbrantner/native-whisperx", rev: "abc" } },
    })).toEqual([]);
  });

  test("rejects inference and model-runtime crates in every dependency table", () => {
    const violations = cargoViolations("backend/Cargo.toml", {
      dependencies: { "candle-core": "0.9" },
      "dev-dependencies": { ort: "2" },
      workspace: { dependencies: { "whisper-rs": "0.14" } },
      target: { "cfg(unix)": { "build-dependencies": { tokenizers: "0.21" } } },
    });
    expect(violations).toHaveLength(4);
  });

  test("rejects renamed capability crates by package name", () => {
    expect(cargoViolations("backend/Cargo.toml", {
      dependencies: { asr: { package: "moenarch-audio-analysis-transcription", version: "0.1" } },
    })).toEqual(["backend/Cargo.toml [dependencies] asr (package moenarch-audio-analysis-transcription)"]);
  });

  test("rejects browser inference packages", () => {
    expect(packageViolations("site/package.json", {
      dependencies: { "@huggingface/transformers": "3", react: "19" },
      devDependencies: { "onnxruntime-web": "1" },
    })).toEqual([
      "site/package.json dependencies @huggingface/transformers",
      "site/package.json devDependencies onnxruntime-web",
    ]);
  });
});
