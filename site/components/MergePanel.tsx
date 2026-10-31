import type { MergeFormat } from "../lib/wasm";

type Props = {
  onDownload: (format: MergeFormat) => void;
};

export function MergePanel({ onDownload }: Props) {
  return (
    <section className="merge-panel" aria-labelledby="merge-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Merge</p>
          <h2 id="merge-heading">Export enabled tracks in timeline order</h2>
        </div>
        <div className="merge-actions">
          <button type="button" onClick={() => onDownload("ass")}>Merged ASS</button>
          <button type="button" onClick={() => onDownload("srt")}>Merged SRT</button>
          <button type="button" onClick={() => onDownload("vtt")}>Merged WebVTT</button>
        </div>
      </div>
      <p className="merge-note">
        ASS keeps tracks simultaneous with one deterministic style/vertical position per track. SRT and WebVTT split the timeline at cue boundaries and join overlapping active track text in the order shown above.
      </p>
    </section>
  );
}
