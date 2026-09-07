"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import {
  currentCue,
  formatClock,
  inferTrackTitle,
  toSrt,
  toWebVtt,
} from "../lib/subtitles";
import type { Cue, Track, VideoInspection } from "../lib/types";
import {
  inspectVideo,
  mergeTracks,
  parseSubtitle,
  type MergeFormat,
} from "../lib/wasm";

const videoAccept = ".mp4,.m4v,.mov,.mkv,.webm,video/*";
const subtitleAccept = ".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip,text/plain";

function fileTrackId(file: File) {
  return `file-${file.name}-${file.size}-${file.lastModified}`;
}

function shiftedTime(milliseconds: number, offsetMs: number) {
  return Math.max(0, milliseconds + offsetMs);
}

function shiftedCue(cue: Cue, offsetMs: number): Cue {
  const startMs = shiftedTime(cue.startMs, offsetMs);
  return {
    ...cue,
    startMs,
    endMs: Math.max(startMs, shiftedTime(cue.endMs, offsetMs)),
  };
}

function trackEnd(track: Track) {
  return track.cues.reduce(
    (end, cue) => Math.max(end, shiftedTime(cue.endMs, track.offsetMs)),
    0,
  );
}

function downloadName(track: Track, extension: string) {
  const slug = track.title
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug || "subtitles"}.${extension}`;
}

function formatByteCount(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function triggerDownload(content: string, mimeType: string, filename: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SubtitleWorkbench() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  const [videoFile, setVideoFile] = useState<File>();
  const [videoUrl, setVideoUrl] = useState("");
  const [inspection, setInspection] = useState<VideoInspection>();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [positionMs, setPositionMs] = useState(0);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  useEffect(() => {
    return () => inspectionAbortRef.current?.abort();
  }, []);

  const durationMs = useMemo(
    () =>
      Math.max(
        videoDurationMs,
        inspection?.durationMs ?? 0,
        ...tracks.map(trackEnd),
        1,
      ),
    [inspection?.durationMs, tracks, videoDurationMs],
  );

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) ?? tracks[0],
    [selectedTrackId, tracks],
  );

  const selectedTrackIndex = selectedTrack
    ? tracks.findIndex((track) => track.id === selectedTrack.id)
    : -1;

  const visibleCues = useMemo(
    () =>
      tracks
        .filter((track) => track.enabled)
        .map((track) => {
          const sourcePosition = positionMs - track.offsetMs;
          return {
            track,
            cue: sourcePosition >= 0 ? currentCue(track.cues, sourcePosition) : undefined,
          };
        })
        .filter((entry) => entry.cue),
    [positionMs, tracks],
  );

  async function handleVideoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

    inspectionAbortRef.current?.abort();
    const controller = new AbortController();
    inspectionAbortRef.current = controller;

    setBusy("Inspecting video container with Rust/WASM…");
    setError("");
    setWarnings([]);
    setInspection(undefined);
    setVideoFile(file);
    setVideoDurationMs(0);
    setPositionMs(0);
    setTracks((current) => current.filter((track) => track.origin === "file"));
    setVideoUrl(URL.createObjectURL(file));

    try {
      const result = await inspectVideo(
        file,
        ({ phase, transferred }) => {
          if (inspectionAbortRef.current === controller) {
            setBusy(`${phase}… ${formatByteCount(transferred)} read locally`);
          }
        },
        controller.signal,
      );
      if (inspectionAbortRef.current !== controller) {
        return;
      }
      const embeddedTracks: Track[] = result.tracks.map((track) => ({
        ...track,
        enabled: true,
        offsetMs: 0,
      }));
      setInspection(result);
      setTracks((current) => {
        const files = current.filter((track) => track.origin === "file");
        return [...embeddedTracks, ...files];
      });
      setWarnings([
        ...result.warnings,
        ...result.unsupported.map(
          (track) => `${track.title} (${track.codec}): ${track.reason}`,
        ),
      ]);
      if (embeddedTracks[0]) {
        setSelectedTrackId(embeddedTracks[0].id);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      if (inspectionAbortRef.current === controller) {
        setError(cause instanceof Error ? cause.message : "The video could not be inspected.");
      }
    } finally {
      if (inspectionAbortRef.current === controller) {
        inspectionAbortRef.current = null;
        setBusy("");
      }
    }
  }

  async function handleSubtitleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) {
      return;
    }

    setBusy(`Parsing ${files.length === 1 ? files[0].name : `${files.length} subtitle files`} with Rust/WASM…`);
    setError("");

    const imported: Track[] = [];
    const importedWarnings: string[] = [];
    for (const file of files) {
      try {
        const parsed = await parseSubtitle(file);
        const track: Track = {
          id: fileTrackId(file),
          title: inferTrackTitle(file.name, videoFile?.name),
          language: "und",
          format: parsed.format,
          codec: parsed.format,
          origin: "file",
          forced: false,
          filename: file.name,
          enabled: true,
          offsetMs: 0,
          cues: parsed.cues,
        };
        imported.push(track);
        importedWarnings.push(...parsed.warnings.map((warning) => `${file.name}: ${warning}`));
      } catch (cause) {
        importedWarnings.push(
          `${file.name}: ${cause instanceof Error ? cause.message : "could not be parsed"}`,
        );
      }
    }

    setTracks((current) => {
      const importedIds = new Set(imported.map((track) => track.id));
      return [...current.filter((track) => !importedIds.has(track.id)), ...imported];
    });
    setWarnings((current) => [...current, ...importedWarnings]);
    if (!selectedTrackId && imported[0]) {
      setSelectedTrackId(imported[0].id);
    }
    setBusy("");
  }

  function toggleTrack(id: string) {
    setTracks((current) =>
      current.map((track) =>
        track.id === id ? { ...track, enabled: !track.enabled } : track,
      ),
    );
  }

  function setTrackOffset(id: string, offsetMs: number) {
    if (!Number.isFinite(offsetMs)) {
      return;
    }
    setTracks((current) =>
      current.map((track) =>
        track.id === id ? { ...track, offsetMs: Math.trunc(offsetMs) } : track,
      ),
    );
  }

  function moveTrack(id: string, direction: -1 | 1) {
    setTracks((current) => {
      const index = current.findIndex((track) => track.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeTrack(id: string) {
    setTracks((current) => current.filter((track) => track.id !== id));
    if (selectedTrackId === id) {
      setSelectedTrackId("");
    }
  }

  function seek(milliseconds: number) {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = milliseconds / 1000;
    setPositionMs(milliseconds);
  }

  function downloadTrack(track: Track, format: "srt" | "vtt") {
    const adjustedTrack = {
      ...track,
      cues: track.cues.map((cue) => shiftedCue(cue, track.offsetMs)),
    };
    const content = format === "srt" ? toSrt(adjustedTrack) : toWebVtt(adjustedTrack);
    triggerDownload(
      content,
      format === "srt" ? "application/x-subrip;charset=utf-8" : "text/vtt;charset=utf-8",
      downloadName(track, format),
    );
  }

  async function downloadMerged(format: MergeFormat) {
    setBusy(`Merging enabled tracks as ${format.toUpperCase()} with Rust/WASM…`);
    setError("");
    try {
      const result = await mergeTracks(tracks, format);
      triggerDownload(
        result.content,
        result.mimeType,
        `merged-subtitles.${result.extension}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The subtitle tracks could not be merged.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="workbench">
      <section className="import-panel" aria-labelledby="import-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Local inputs</p>
            <h2 id="import-heading">Reference video and subtitle files</h2>
          </div>
          <p className="privacy-note">Processed locally. Nothing is uploaded.</p>
        </div>

        <div className="input-grid">
          <label className="file-target">
            <span className="file-target-label">Reference video</span>
            <strong>{videoFile?.name ?? "Choose one video file"}</strong>
            <span>MP4/MOV and Matroska/WebM can be inspected for embedded text subtitles.</span>
            <input type="file" accept={videoAccept} onChange={handleVideoChange} />
          </label>

          <label className="file-target">
            <span className="file-target-label">Subtitle files</span>
            <strong>Add SRT, WebVTT, ASS, or SSA</strong>
            <span>Select several files at once; importing the same file again replaces that track.</span>
            <input type="file" accept={subtitleAccept} multiple onChange={handleSubtitleChange} />
          </label>
        </div>

        {busy ? <p className="status-line">{busy}</p> : null}
        {error ? <p className="error-line">{error}</p> : null}
        {warnings.length > 0 ? (
          <details className="warnings">
            <summary>Warnings ({warnings.length})</summary>
            <ul>
              {warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="preview-panel" aria-labelledby="preview-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Reference video</p>
            <h2 id="preview-heading">Preview</h2>
          </div>
          {inspection ? (
            <p className="container-label">
              {inspection.container} · {inspection.durationMs ? formatClock(inspection.durationMs) : "duration from browser"}
            </p>
          ) : null}
        </div>

        <div className="video-stage">
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                playsInline
                onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
                onLoadedMetadata={(event) => {
                  if (Number.isFinite(event.currentTarget.duration)) {
                    setVideoDurationMs(event.currentTarget.duration * 1000);
                  }
                }}
              />
              {visibleCues.length > 0 ? (
                <div className="subtitle-overlay" aria-live="off">
                  {visibleCues.map(({ track, cue }) => (
                    <p key={track.id}>
                      <span>{track.title}</span>
                      {cue?.text}
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-stage">
              <p>Select a reference video to start.</p>
              <span>The browser may not be able to play every codec even when Rust can inspect its container.</span>
            </div>
          )}
        </div>
      </section>

      <section className="tracks-panel" aria-labelledby="tracks-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Timeline</p>
            <h2 id="tracks-heading">Subtitle tracks</h2>
          </div>
          <p className="time-readout">{formatClock(positionMs)}</p>
        </div>

        {tracks.length === 0 ? (
          <p className="empty-copy">
            Embedded text tracks appear here after video inspection. You can also add subtitle files before or after selecting a video.
          </p>
        ) : (
          <div className="timeline" role="list">
            <div className="timeline-ruler" aria-hidden="true">
              <span>0</span>
              <span>{formatClock(durationMs / 2)}</span>
              <span>{formatClock(durationMs)}</span>
            </div>
            {tracks.map((track) => (
              <div className="timeline-row" role="listitem" key={track.id}>
                <div className="track-label">
                  <label>
                    <input
                      type="checkbox"
                      checked={track.enabled}
                      onChange={() => toggleTrack(track.id)}
                    />
                    <span>
                      <strong>{track.title}</strong>
                      <small>
                        {track.origin === "embedded" ? "embedded" : track.filename} · {track.codec} · {track.cues.length} cues
                        {track.offsetMs !== 0 ? ` · offset ${track.offsetMs > 0 ? "+" : ""}${track.offsetMs} ms` : ""}
                      </small>
                    </span>
                  </label>
                  <button type="button" className="text-button" onClick={() => setSelectedTrackId(track.id)}>
                    Inspect
                  </button>
                </div>
                <div className="cue-lane">
                  {track.cues.map((cue, index) => {
                    const adjusted = shiftedCue(cue, track.offsetMs);
                    const left = Math.min(100, (adjusted.startMs / durationMs) * 100);
                    const width = Math.max(
                      0.16,
                      Math.min(100 - left, ((adjusted.endMs - adjusted.startMs) / durationMs) * 100),
                    );
                    return (
                      <button
                        className="cue-block"
                        type="button"
                        key={`${cue.startMs}-${cue.endMs}-${index}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${formatClock(adjusted.startMs)} — ${cue.text}`}
                        aria-label={`Seek to ${formatClock(adjusted.startMs)}: ${cue.text}`}
                        onClick={() => seek(adjusted.startMs)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {tracks.length > 0 ? (
        <section className="merge-panel" aria-labelledby="merge-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Merge</p>
              <h2 id="merge-heading">Export enabled tracks in timeline order</h2>
            </div>
            <div className="merge-actions">
              <button type="button" onClick={() => downloadMerged("ass")}>Merged ASS</button>
              <button type="button" onClick={() => downloadMerged("srt")}>Merged SRT</button>
              <button type="button" onClick={() => downloadMerged("vtt")}>Merged WebVTT</button>
            </div>
          </div>
          <p className="merge-note">
            ASS keeps tracks simultaneous with one deterministic style/vertical position per track. SRT and WebVTT split the timeline at cue boundaries and join overlapping active track text in the order shown above.
          </p>
        </section>
      ) : null}

      {selectedTrack ? (
        <section className="detail-panel" aria-labelledby="detail-heading">
          <div className="section-heading detail-heading">
            <div>
              <p className="eyebrow">Track detail</p>
              <h2 id="detail-heading">{selectedTrack.title}</h2>
              <p className="track-meta">
                {selectedTrack.origin === "embedded" ? "Embedded track" : selectedTrack.filename} · {selectedTrack.format}
                {selectedTrack.language !== "und" ? ` · ${selectedTrack.language}` : ""}
                {selectedTrack.forced ? " · forced" : ""}
              </p>
            </div>
            <div className="detail-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={selectedTrackIndex <= 0}
                onClick={() => moveTrack(selectedTrack.id, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={selectedTrackIndex < 0 || selectedTrackIndex >= tracks.length - 1}
                onClick={() => moveTrack(selectedTrack.id, 1)}
              >
                Move down
              </button>
              <button type="button" onClick={() => downloadTrack(selectedTrack, "srt")}>Download SRT</button>
              <button type="button" onClick={() => downloadTrack(selectedTrack, "vtt")}>Download VTT</button>
              <button type="button" className="secondary-button" onClick={() => removeTrack(selectedTrack.id)}>Remove</button>
            </div>
          </div>

          <label className="offset-control">
            <span>Track offset (milliseconds)</span>
            <input
              type="number"
              step="100"
              value={selectedTrack.offsetMs}
              onChange={(event) => setTrackOffset(selectedTrack.id, Number(event.currentTarget.value))}
            />
            <small>Positive values delay this track; negative values move it earlier. Exported and preview timing both use this offset.</small>
          </label>

          <div className="cue-table-wrap">
            <table className="cue-table">
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {selectedTrack.cues.map((cue, index) => {
                  const adjusted = shiftedCue(cue, selectedTrack.offsetMs);
                  return (
                    <tr key={`${cue.startMs}-${cue.endMs}-${index}`} onClick={() => seek(adjusted.startMs)}>
                      <td>{formatClock(adjusted.startMs)}</td>
                      <td>{formatClock(adjusted.endMs)}</td>
                      <td>{cue.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="support-panel" aria-labelledby="support-heading">
        <div>
          <p className="eyebrow">Embedded subtitle support</p>
          <h2 id="support-heading">Text tracks are extracted; bitmap tracks stay explicit.</h2>
        </div>
        <p>
          MP4/MOV extraction covers tx3g, WebVTT (wvtt), and TTML (stpp). Matroska/WebM covers UTF-8, WebVTT, ASS/SSA, and USF text tracks. PGS, VobSub, and other bitmap subtitle codecs are reported as unsupported rather than silently discarded.
        </p>
        <p>
          Video inspection runs in a Web Worker and streams only the byte ranges requested by Rust. MP4 metadata reads are capped at 64 MiB, coalesced subtitle-sample reads at 4 MiB, and Matroska subtitle blocks at 16 MiB. No server fallback is used.
        </p>
      </section>
    </div>
  );
}
