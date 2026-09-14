import { qualityCueIndexes, qualityDiagnosticCueLabel } from "../lib/quality-view";
import type { SubtitleQualityReport } from "../lib/types";

type SubtitleQualityPanelProps = {
  trackTitle: string;
  sourceAvailable: boolean;
  report?: SubtitleQualityReport;
  busy: boolean;
  error: string;
  onSelectCue: (cueIndex: number) => void;
};

export function SubtitleQualityPanel({
  trackTitle,
  sourceAvailable,
  report,
  busy,
  error,
  onSelectCue,
}: SubtitleQualityPanelProps) {
  const affectedCueCount = report ? qualityCueIndexes(report.diagnostics).size : 0;

  return (
    <section className="quality-panel" aria-labelledby="quality-heading" aria-live="polite">
      <div className="quality-heading">
        <div>
          <strong id="quality-heading">Quality diagnostics</strong>
          <small>
            {report
              ? `${report.diagnostics.length} findings across ${affectedCueCount} cues in ${trackTitle}`
              : `Read-only Rust analysis for ${trackTitle}`}
          </small>
        </div>
        {report ? <small>{report.profile.name}</small> : null}
      </div>

      {!sourceAvailable ? (
        <p className="quality-status">
          Quality analysis needs the retained source subtitle document. Embedded tracks remain unavailable until extraction retains that rich source document.
        </p>
      ) : busy ? (
        <p className="quality-status">Analyzing the accepted source document with Rust/WASM…</p>
      ) : error ? (
        <p className="quality-status error">{error}</p>
      ) : report ? (
        <>
          <details className="quality-profile">
            <summary>Profile thresholds</summary>
            <dl>
              <div><dt>Reading speed</dt><dd>≤ {report.profile.maxCharactersPerSecond} chars/s</dd></div>
              <div><dt>Line length</dt><dd>≤ {report.profile.maxCharactersPerLine} chars</dd></div>
              <div><dt>Lines</dt><dd>≤ {report.profile.maxLines}</dd></div>
              <div><dt>Duration</dt><dd>{report.profile.minDurationMs}–{report.profile.maxDurationMs} ms</dd></div>
              <div><dt>Gap</dt><dd>≥ {report.profile.minGapMs} ms</dd></div>
              <div><dt>Analyzed</dt><dd>{report.analyzedCueCount} cues</dd></div>
            </dl>
          </details>
          {report.diagnostics.length === 0 ? (
            <p className="quality-status clean">No findings for this profile.</p>
          ) : (
            <ol className="quality-list">
              {report.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}-${diagnostic.cueIndex}-${diagnostic.relatedCueIndex ?? "none"}-${index}`}>
                  <button
                    type="button"
                    className="quality-finding-button"
                    onClick={() => onSelectCue(diagnostic.cueIndex)}
                  >
                    <span className="quality-finding-meta">
                      <span>{qualityDiagnosticCueLabel(diagnostic)}</span>
                      <span className="quality-code">{diagnostic.code}</span>
                    </span>
                    <span>{diagnostic.message}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <p className="quality-status">Select an editable source-backed track to analyze it.</p>
      )}
    </section>
  );
}
