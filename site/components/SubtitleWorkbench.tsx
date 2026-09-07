"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import {
  currentCue,
  formatClock,
  inferTrackTitle,
  toSrt,
  toWebVtt,
} from "../lib/subtitles";
import type { Track, VideoInspection } from "../lib/types";
import { inspectVideo, parseSubtitle } from "../lib/wasm";

const videoAccept = ".mp4,.m4v,.mov,.mkv,.webm,video/*";
const subtitleAccept = ".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip,text/plain";

function fileTrackId(file: File) {
  return `file-${file.name}-${file.size}-${file.lastModified}`;
}

function trackEnd(track: Track) {
  return track.cues.reduce((end, cue) => Math.max(end, cue.endMs), 0);
}

function downloadName(track: Track, extension: string) {
  const slug = track.title
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug || "subtitles"}.${extension}`;
}

export function SubtitleWorkbench() {
  const videoRef = useRef<HTMLVideoElement>(null);
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

  const visibleCues = useMemo(
    () =>
      tracks
        .filter((track) => track.enabled)
        .map((track) => ({ track, cue: currentCue(track.cues, positionMs) }))
        .filter((entry) => entry.cue),
    [positionMs, tracks],
  );

  async function handleVideoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

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
      const result = await inspectVideo(file);
      const embeddedTracks: Track[] = result.tracks.map((track) => ({
        ...track,
        enabled: true,
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
      setError(cause instanceof Error ? cause.message : "The video could not be inspected.");
    } finally {
      setBusy("");
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
    const content = format === "srt" ? toSrt(track) : toWebVtt(track);
    const blob = new Blob([content], {
      type: format === "srt" ? "application/x-subrip;charset=utf-8" : "text/vtt;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName(track, format);
    anchor.click();
    URL.revokeObjectURL(url);
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
                      </small>
                    </span>
                  </label>
                  <button type="button" className="text-button" onClick={() => setSelectedTrackId(track.id)}>
                    Inspect
                  </button>
                </div>
                <div className="cue-lane">
                  {track.cues.map((cue, index) => {
                    const left = Math.min(100, (cue.startMs / durationMs) * 100);
                    const width = Math.max(0.16, Math.min(100 - left, ((cue.endMs - cue.startMs) / durationMs) * 100));
                    return (
                      <button
                        className="cue-block"
                        type="button"
                        key={`${cue.startMs}-${cue.endMs}-${index}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${formatClock(cue.startMs)} — ${cue.text}`}
                        aria-label={`Seek to ${formatClock(cue.startMs)}: ${cue.text}`}
                        onClick={() => seek(cue.startMs)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

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
              <button type="button" onClick={() => downloadTrack(selectedTrack, "srt")}>Download SRT</button>
              <button type="button" onClick={() => downloadTrack(selectedTrack, "vtt")}>Download VTT</button>
              <button type="button" className="secondary-button" onClick={() => removeTrack(selectedTrack.id)}>Remove</button>
            </div>
          </div>

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
                {selectedTrack.cues.map((cue, index) => (
                  <tr key={`${cue.startMs}-${cue.endMs}-${index}`} onClick={() => seek(cue.startMs)}>
                    <td>{formatClock(cue.startMs)}</td>
                    <td>{formatClock(cue.endMs)}</td>
                    <td>{cue.text}</td>
                  </tr>
                ))}
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
          The current WASM boundary reads the selected file into browser memory, so very large videos require memory roughly proportional to file size. No server fallback is used.
        </p>
      </section>
    </div>
  );
}
