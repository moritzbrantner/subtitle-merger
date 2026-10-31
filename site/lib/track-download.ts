import type { Track } from "./types";

export function downloadName(track: Track, extension: string) {
  const slug = track.title
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug || "subtitles"}.${extension}`;
}

export function sourceExtension(format: string) {
  switch (format.toLowerCase()) {
    case "webvtt":
    case "vtt":
      return "vtt";
    case "ass":
      return "ass";
    case "ssa":
      return "ssa";
    default:
      return "srt";
  }
}

export function sourceMimeType(format: string) {
  return format.toLowerCase() === "webvtt" || format.toLowerCase() === "vtt"
    ? "text/vtt;charset=utf-8"
    : "text/plain;charset=utf-8";
}

export function triggerDownload(content: string, mimeType: string, filename: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function triggerByteDownload(content: Uint8Array, mimeType: string, filename: string) {
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
