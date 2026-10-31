import { useEffect, useState } from "react";

import {
  inspectBrowserTranscriptionSupport,
  type BrowserTranscriptionSupport,
} from "../lib/browser-transcription";

export function useBrowserTranscriptionSupport() {
  const [browserTranscriptionSupport, setBrowserTranscriptionSupport] =
    useState<BrowserTranscriptionSupport>();
  const [browserTranscriptionModelId, setBrowserTranscriptionModelId] = useState("");

  useEffect(() => {
    let active = true;
    inspectBrowserTranscriptionSupport()
      .then((support) => {
        if (active) {
          setBrowserTranscriptionSupport(support);
          if (support.available) {
            setBrowserTranscriptionModelId((current) =>
              support.models.some((model) => model.id === current)
                ? current
                : support.modelId,
            );
          }
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setBrowserTranscriptionSupport({
            available: false,
            reason: cause instanceof Error
              ? cause.message
              : "Browser transcription is unavailable.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedBrowserTranscriptionModel =
    browserTranscriptionSupport?.available === true
      ? browserTranscriptionSupport.models.find(
          (model) => model.id === browserTranscriptionModelId,
        )
      : undefined;

  return {
    browserTranscriptionSupport,
    browserTranscriptionModelId,
    setBrowserTranscriptionModelId,
    selectedBrowserTranscriptionModel,
  };
}
