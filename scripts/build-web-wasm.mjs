import { copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const manifest = resolve(repositoryRoot, "web-wasm", "Cargo.toml");
const outputDirectory = resolve(repositoryRoot, "site", "public");
const source = resolve(
  repositoryRoot,
  "web-wasm",
  "target",
  "wasm32-unknown-unknown",
  "release",
  "subtitle_merger_web_wasm.wasm",
);
const destination = resolve(outputDirectory, "subtitle_merger_web_wasm.wasm");

const result = spawnSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    manifest,
    "--locked",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await mkdir(outputDirectory, { recursive: true });
await copyFile(source, destination);
console.log(`Copied ${source} -> ${destination}`);
