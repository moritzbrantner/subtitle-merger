export const subtitleJobStates = [
  'queued',
  'running',
  'completed',
  'cancelled',
  'failed',
] as const

export type SubtitleJobState = (typeof subtitleJobStates)[number]

export const subtitleJobPhases = [
  'queued',
  'decoding',
  'detectingSpeech',
  'transcribing',
  'aligning',
  'diarizing',
  'translating',
  'writingOutput',
  'completed',
  'cancelled',
  'failed',
] as const

export type SubtitleJobPhase = (typeof subtitleJobPhases)[number]

export type GeneratedCue = {
  startMs: number
  endMs: number
  text: string
  actor?: string
}

export type GeneratedTrack = {
  language: string
  pivoted: boolean
  cues: GeneratedCue[]
}

export type SubtitleJob = {
  jobId: string
  sessionId: string
  state: SubtitleJobState
  phase: SubtitleJobPhase
  progress: number
  message: string
  sourceTrack: GeneratedTrack | null
  translationTrack: GeneratedTrack | null
}

export type SubtitleJobProgress = {
  state: 'running'
  phase: SubtitleJobPhase
}

export type SubtitleJobUpdate =
  | { kind: 'progress'; progress: SubtitleJobProgress }
  | { kind: 'snapshot'; job: SubtitleJob }
