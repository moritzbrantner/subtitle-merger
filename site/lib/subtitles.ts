import type { Cue, Track } from "./types";

export function currentCue(cues: Cue[], positionMs: number) {
  return cues.find((cue) => cue.startMs <= positionMs && positionMs < cue.endMs);
}

export function formatClock(milliseconds: number) {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

export function inferTrackTitle(filename: string, videoFilename?: string) {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  if (!videoFilename) {
    return withoutExtension;
  }
  const videoStem = videoFilename.replace(/\.[^.]+$/, "");
  if (withoutExtension === videoStem) {
    return "Subtitles";
  }
  if (withoutExtension.startsWith(`${videoStem}.`) || withoutExtension.startsWith(`${videoStem}-`) || withoutExtension.startsWith(`${videoStem}_`)) {
    return withoutExtension.slice(videoStem.length + 1).replace(/[._-]+/g, " ") || "Subtitles";
  }
  return withoutExtension;
}

export function toSrt(track: Track) {
  return track.cues
    .map((cue, index) => {
      const start = formatClock(cue.startMs).replace(".", ",");
      const end = formatClock(cue.endMs).replace(".", ",");
      return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
    })
    .join("\n\n");
}

export function toWebVtt(track: Track) {
  const body = track.cues
    .map((cue) => `${formatClock(cue.startMs)} --> ${formatClock(cue.endMs)}\n${cue.text}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
