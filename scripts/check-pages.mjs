import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "site", "out");
const indexPath = resolve(out, "index.html");
const wasmPath = resolve(out, "subtitle_merger_web_wasm.wasm");

await access(indexPath, constants.R_OK);
await access(wasmPath, constants.R_OK);
const html = await readFile(indexPath, "utf8");
if (!html.includes("Subtitle Merger") || !html.includes("browser lab")) {
  throw new Error("Static export does not contain the expected Subtitle Merger surface.");
}
const wasm = await stat(wasmPath);
if (wasm.size < 1000) {
  throw new Error("Rust WebAssembly asset is unexpectedly small.");
}
console.log(`Verified static Pages export (${wasm.size} byte WASM asset).`);
