import type { ChangeEvent } from "react";

import type {
  BrowserTranscriptionModel,
  BrowserTranscriptionSupport,
} from "../lib/browser-transcription";
import {
  browserGenerationDescription,
  browserGenerationTitle,
} from "../lib/workbench";

const videoAccept = ".mp4,.m4v,.mov,.mkv,.webm,video/*";
const subtitleAccept = ".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip,text/plain";

type Props = {
  videoFile: File | undefined;
  busy: string;
  error: string;
  warnings: string[];
  generatingSubtitles: boolean;
  browserTranscriptionSupport: BrowserTranscriptionSupport | undefined;
  browserTranscriptionModelId: string;
  selectedBrowserTranscriptionModel: BrowserTranscriptionModel | undefined;
  onBrowserTranscriptionModelChange: (modelId: string) => void;
  onVideoChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubtitleChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onGenerateSubtitles: () => void;
};

export function ImportPanel({
  videoFile,
  busy,
  error,
  warnings,
  generatingSubtitles,
  browserTranscriptionSupport,
  browserTranscriptionModelId,
  selectedBrowserTranscriptionModel,
  onBrowserTranscriptionModelChange,
  onVideoChange,
  onSubtitleChange,
  onGenerateSubtitles,
}: Props) {
  return (
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
          <input
            type="file"
            accept={videoAccept}
            disabled={generatingSubtitles}
            onChange={onVideoChange}
          />
        </label>

        <label className="file-target">
          <span className="file-target-label">Subtitle files</span>
          <strong>Add SRT, WebVTT, ASS, or SSA</strong>
          <span>Select several files at once; importing the same file again replaces that track.</span>
          <input
            type="file"
            accept={subtitleAccept}
            multiple
            disabled={generatingSubtitles}
            onChange={onSubtitleChange}
          />
        </label>

        <div className="browser-generation-panel">
          <label className="browser-model-control" htmlFor="browser-whisper-model">
            <span className="file-target-label">Whisper model</span>
            <select
              id="browser-whisper-model"
              value={browserTranscriptionModelId}
              disabled={
                generatingSubtitles
                || browserTranscriptionSupport?.available !== true
              }
              onChange={(event) => onBrowserTranscriptionModelChange(event.target.value)}
            >
              {browserTranscriptionSupport?.available === true ? (
                browserTranscriptionSupport.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))
              ) : (
                <option value="">
                  {browserTranscriptionSupport
                    ? "Browser transcription unavailable"
                    : "Checking models…"}
                </option>
              )}
            </select>
            <span className="browser-model-description">
              {browserGenerationDescription(
                browserTranscriptionSupport,
                selectedBrowserTranscriptionModel,
              )}
            </span>
          </label>

          <button
            type="button"
            className="browser-generate-target"
            disabled={
              !videoFile
              || Boolean(busy)
              || generatingSubtitles
              || browserTranscriptionSupport?.available !== true
              || !selectedBrowserTranscriptionModel
            }
            onClick={onGenerateSubtitles}
          >
            <span className="file-target-label">Generate subtitles</span>
            <strong>
              {browserGenerationTitle(
                browserTranscriptionSupport,
                selectedBrowserTranscriptionModel,
              )}
            </strong>
            <span>Runs locally in this browser; model assets are cached after first use.</span>
          </button>
        </div>
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
  );
}
