export type Cue = {
  startMs: number;
  endMs: number;
  text: string;
  rawText?: string;
  identifier?: string | null;
  settings?: string;
};

export type EmbeddedTrack = {
  id: string;
  title: string;
  language: string;
  format: string;
  codec: string;
  origin: "embedded";
  forced: boolean;
  cues: Cue[];
};

export type UnsupportedTrack = {
  title: string;
  language: string;
  codec: string;
  reason: string;
};

export type VideoInspection = {
  container: string;
  durationMs: number | null;
  tracks: EmbeddedTrack[];
  unsupported: UnsupportedTrack[];
  warnings: string[];
};

export type ParsedSubtitle = {
  format: string;
  cues: Cue[];
  warnings: string[];
};

export type SubtitleQualityProfile = {
  name: string;
  maxCharactersPerSecond: number;
  maxCharactersPerLine: number;
  maxLines: number;
  minDurationMs: number;
  maxDurationMs: number;
  minGapMs: number;
};

export type SubtitleQualityDiagnostic = {
  code: string;
  severity: "warning";
  cueIndex: number;
  relatedCueIndex: number | null;
  message: string;
};

export type SubtitleQualityReport = {
  profile: SubtitleQualityProfile;
  analyzedCueCount: number;
  diagnostics: SubtitleQualityDiagnostic[];
};

export type Track = {
  id: string;
  title: string;
  language: string;
  format: string;
  codec: string;
  origin: "embedded" | "file" | "generated";
  forced: boolean;
  filename?: string;
  enabled: boolean;
  offsetMs: number;
  cues: Cue[];
  sourceBytes?: Uint8Array;
};