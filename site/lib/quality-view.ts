import type { SubtitleQualityDiagnostic } from "./types";

export function qualityCueIndexes(diagnostics: SubtitleQualityDiagnostic[]): Set<number> {
  const indexes = new Set<number>();
  for (const diagnostic of diagnostics) {
    indexes.add(diagnostic.cueIndex);
    if (diagnostic.relatedCueIndex !== null) {
      indexes.add(diagnostic.relatedCueIndex);
    }
  }
  return indexes;
}

export function qualityDiagnosticCueLabel(diagnostic: SubtitleQualityDiagnostic): string {
  const primary = `Cue ${diagnostic.cueIndex + 1}`;
  return diagnostic.relatedCueIndex === null
    ? primary
    : `${primary} ↔ Cue ${diagnostic.relatedCueIndex + 1}`;
}
