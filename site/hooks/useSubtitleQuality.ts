import { useEffect, useRef, useState } from "react";

import type { SubtitleQualityReport, Track } from "../lib/types";
import { analyzeSubtitleQuality } from "../lib/wasm";

export function useSubtitleQuality(selectedTrack: Track | undefined) {
  const qualityRequestRef = useRef(0);
  const [qualityReport, setQualityReport] = useState<SubtitleQualityReport>();
  const [qualityError, setQualityError] = useState("");
  const [qualityBusy, setQualityBusy] = useState(false);

  useEffect(() => {
    const requestId = ++qualityRequestRef.current;
    const source = selectedTrack?.sourceBytes;
    setQualityReport(undefined);
    setQualityError("");

    if (!source) {
      setQualityBusy(false);
      return;
    }

    setQualityBusy(true);
    void analyzeSubtitleQuality(source)
      .then((report) => {
        if (qualityRequestRef.current === requestId) {
          setQualityReport(report);
        }
      })
      .catch((cause) => {
        if (qualityRequestRef.current === requestId) {
          setQualityError(
            cause instanceof Error ? cause.message : "Subtitle quality analysis failed.",
          );
        }
      })
      .finally(() => {
        if (qualityRequestRef.current === requestId) {
          setQualityBusy(false);
        }
      });
  }, [selectedTrack?.id, selectedTrack?.sourceBytes]);

  return { qualityReport, qualityError, qualityBusy };
}
