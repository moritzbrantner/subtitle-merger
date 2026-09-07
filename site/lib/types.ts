export type Cue = {
  startMs: number;
  endMs: number;
  text: string;
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

export type Track = {
  id: string;
  title: string;
  language: string;
  format: string;
  codec: string;
  origin: "embedded" | "file";
  forced: boolean;
  filename?: string;
  enabled: boolean;
  cues: Cue[];
};
