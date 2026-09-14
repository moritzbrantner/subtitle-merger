import type { DriftCorrectionDraft } from "../lib/drift-view";

import styles from "./DriftCorrectionPanel.module.css";

type AnchorName = "first" | "second";
type AnchorField = "sourceMs" | "referenceMs";

type DriftCorrectionPanelProps = {
  trackTitle: string;
  trackOffsetMs: number;
  sourceAvailable: boolean;
  busy: boolean;
  hasCueDrafts: boolean;
  draft: DriftCorrectionDraft;
  onChange: (anchor: AnchorName, field: AnchorField, value: string) => void;
  onClear: () => void;
  onApply: () => void;
};

function AnchorFields({
  title,
  anchor,
  values,
  disabled,
  onChange,
}: {
  title: string;
  anchor: AnchorName;
  values: DriftCorrectionDraft[AnchorName];
  disabled: boolean;
  onChange: DriftCorrectionPanelProps["onChange"];
}) {
  return (
    <div className={styles.anchor}>
      <span className={styles.anchorTitle}>{title}</span>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>Subtitle source ms</span>
          <input
            type="number"
            min="0"
            step="1"
            disabled={disabled}
            value={values.sourceMs}
            onChange={(event) => onChange(anchor, "sourceMs", event.currentTarget.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Reference video ms</span>
          <input
            type="number"
            min="0"
            step="1"
            disabled={disabled}
            value={values.referenceMs}
            onChange={(event) => onChange(anchor, "referenceMs", event.currentTarget.value)}
          />
        </label>
      </div>
    </div>
  );
}

export function DriftCorrectionPanel({
  trackTitle,
  trackOffsetMs,
  sourceAvailable,
  busy,
  hasCueDrafts,
  draft,
  onChange,
  onClear,
  onApply,
}: DriftCorrectionPanelProps) {
  const disabled = busy || !sourceAvailable;
  const incomplete = !draft.first.sourceMs
    || !draft.first.referenceMs
    || !draft.second.sourceMs
    || !draft.second.referenceMs;

  return (
    <section className={styles.panel} aria-labelledby="drift-correction-heading">
      <div className={styles.heading}>
        <div>
          <strong id="drift-correction-heading">Two-anchor drift correction</strong>
          <small>
            Map two source subtitle points to where they should occur in the reference video.
          </small>
        </div>
        <small>{trackTitle}</small>
      </div>

      <div className={styles.anchors}>
        <AnchorFields
          title="First anchor"
          anchor="first"
          values={draft.first}
          disabled={disabled}
          onChange={onChange}
        />
        <AnchorFields
          title="Second anchor"
          anchor="second"
          values={draft.second}
          disabled={disabled}
          onChange={onChange}
        />
      </div>

      <div className={styles.footer}>
        <p className={styles.note}>
          Pause the reference video at the correct time, then use Anchor 1 or Anchor 2 on a cue row to capture that cue&apos;s source start and the current playhead. Rust applies one linear timing transform to the accepted source document. The existing {trackOffsetMs >= 0 ? "+" : ""}{trackOffsetMs} ms whole-track offset stays separate and is not baked into the source file.
        </p>
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={onClear}>Clear</button>
          <button
            type="button"
            disabled={disabled || incomplete || hasCueDrafts}
            title={hasCueDrafts ? "Save pending cue drafts before applying drift correction." : undefined}
            onClick={onApply}
          >
            Apply correction
          </button>
        </div>
      </div>

      {!sourceAvailable ? (
        <p className="quality-status">
          Drift correction needs the retained source subtitle document. Embedded tracks remain read-only until extraction retains that document.
        </p>
      ) : null}
    </section>
  );
}
