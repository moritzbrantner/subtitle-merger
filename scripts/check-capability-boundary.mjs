// Keeps reusable ASR, alignment, translation and model-runtime implementations out of the editor.
// Subtitle Merger consumes them through Native WhisperX (native) and the pinned audio-analysis browser
// runtime (Pages); see docs/adr/0003-released-native-whisperx-boundary.md and `.repository.toml`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CARGO_DEPENDENCY_TABLES = ["dependencies", "dev-dependencies", "build-dependencies"];
const PACKAGE_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// Crates that implement inference, model runtimes, tokenization/model hubs or speech/translation models.
export const FORBIDDEN_CRATES = [
  /^candle(-|$)/,
  /^ort(-sys)?$/,
  /^onnxruntime/,
  /^whisper/,
  /^tch$/,
  /^tokenizers$/,
  /^hf-hub$/,
  /^ct2rs$/,
  /^rust-bert$/,
  /^burn(-|$)/,
  /^llama/,
  /^moenarch-audio-analysis-/,
  /^moenarch-model-runtime$/,
  /^moenarch-runtime-/,
];

export const FORBIDDEN_PACKAGES = [
  /^@huggingface\/transformers$/,
  /^@xenova\//,
  /^onnxruntime-/,
  /whisper/,
  /^@tensorflow\//,
  /^@mediapipe\//,
  /^@mlc-ai\//,
];

export const CARGO_MANIFESTS = ["Cargo.toml", "backend/Cargo.toml", "web-wasm/Cargo.toml"];
export const PACKAGE_MANIFESTS = ["package.json", "frontend/package.json", "site/package.json"];

function cargoDependencyTables(manifest) {
  const tables = [];
  for (const name of CARGO_DEPENDENCY_TABLES) {
    if (manifest[name]) tables.push([name, manifest[name]]);
    if (manifest.workspace?.[name]) tables.push([`workspace.${name}`, manifest.workspace[name]]);
  }
  for (const [target, spec] of Object.entries(manifest.target ?? {})) {
    for (const name of CARGO_DEPENDENCY_TABLES) {
      if (spec?.[name]) tables.push([`target.${target}.${name}`, spec[name]]);
    }
  }
  return tables;
}

export function cargoViolations(path, manifest) {
  const violations = [];
  for (const [table, dependencies] of cargoDependencyTables(manifest)) {
    for (const [key, spec] of Object.entries(dependencies)) {
      const crate = typeof spec === "object" && spec?.package ? spec.package : key;
      if (FORBIDDEN_CRATES.some((pattern) => pattern.test(crate))) {
        violations.push(`${path} [${table}] ${key}${crate === key ? "" : ` (package ${crate})`}`);
      }
    }
  }
  return violations;
}

export function packageViolations(path, manifest) {
  const violations = [];
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (FORBIDDEN_PACKAGES.some((pattern) => pattern.test(name))) {
        violations.push(`${path} ${field} ${name}`);
      }
    }
  }
  return violations;
}

export function checkRepository(root) {
  const violations = [];
  for (const path of CARGO_MANIFESTS) {
    violations.push(...cargoViolations(path, Bun.TOML.parse(readFileSync(resolve(root, path), "utf8"))));
  }
  for (const path of PACKAGE_MANIFESTS) {
    violations.push(...packageViolations(path, JSON.parse(readFileSync(resolve(root, path), "utf8"))));
  }
  return violations;
}

if (import.meta.main) {
  const violations = checkRepository(resolve(import.meta.dirname, ".."));
  if (violations.length > 0) {
    console.error("Direct ASR/alignment/translation/model-runtime dependencies belong to Native WhisperX or the capability repositories, not the editor:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log("Capability boundary: no direct ASR/model-runtime dependencies.");
}
