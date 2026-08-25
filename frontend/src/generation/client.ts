import {
  subtitleJobPhases,
  subtitleJobStates,
  type GeneratedCue,
  type GeneratedTrack,
  type SubtitleJob,
  type SubtitleJobPhase,
  type SubtitleJobState,
  type SubtitleJobUpdate,
} from './types'

export type GenerationVideo = {
  filename: string
  mediaUrl: string
  mimeType: string
}

export type StartSubtitleGenerationOptions = {
  video: GenerationVideo
  targetLanguage?: string
  diarize: boolean
  sourceLanguage?: string
}

export type SubtitleJobSubscription = {
  close: () => void
}

type Fetcher = typeof fetch

type SubtitleEventSource = {
  addEventListener: (type: 'progress', listener: (event: MessageEvent<string>) => void) => void
  close: () => void
  onerror: (() => void) | null
}

type SubscribeSubtitleJobOptions = {
  fetcher?: Fetcher
  eventSourceFactory?: (url: string) => SubtitleEventSource
  onProtocolError?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]

  if (typeof value !== 'string') {
    throw new Error(`Subtitle generation response has an invalid ${key}.`)
  }

  return value
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Subtitle generation response has an invalid ${key}.`)
  }

  return value
}

function readJobState(record: Record<string, unknown>): SubtitleJobState {
  const state = readString(record, 'state')

  if (!subtitleJobStates.includes(state as SubtitleJobState)) {
    throw new Error(`Subtitle generation response has an unknown state: ${state}.`)
  }

  return state as SubtitleJobState
}

function readJobPhase(record: Record<string, unknown>): SubtitleJobPhase {
  const phase = readString(record, 'phase')

  if (!subtitleJobPhases.includes(phase as SubtitleJobPhase)) {
    throw new Error(`Subtitle generation response has an unknown phase: ${phase}.`)
  }

  return phase as SubtitleJobPhase
}

function parseCue(value: unknown): GeneratedCue {
  if (!isRecord(value)) {
    throw new Error('Subtitle generation response has an invalid cue.')
  }

  const actor = value.actor

  if (actor !== undefined && actor !== null && typeof actor !== 'string') {
    throw new Error('Subtitle generation response has an invalid cue actor.')
  }

  return {
    startMs: readNumber(value, 'startMs'),
    endMs: readNumber(value, 'endMs'),
    text: readString(value, 'text'),
    actor: typeof actor === 'string' ? actor : undefined,
  }
}

function parseTrack(value: unknown): GeneratedTrack | null {
  if (value === null || value === undefined) {
    return null
  }

  if (!isRecord(value) || typeof value.pivoted !== 'boolean' || !Array.isArray(value.cues)) {
    throw new Error('Subtitle generation response has an invalid track.')
  }

  return {
    language: readString(value, 'language'),
    pivoted: value.pivoted,
    cues: value.cues.map(parseCue),
  }
}

export function parseSubtitleJob(value: unknown): SubtitleJob {
  if (!isRecord(value)) {
    throw new Error('Subtitle generation response is invalid.')
  }

  return {
    jobId: readString(value, 'jobId'),
    sessionId: readString(value, 'sessionId'),
    state: readJobState(value),
    phase: readJobPhase(value),
    progress: readNumber(value, 'progress'),
    message: readString(value, 'message'),
    sourceTrack: parseTrack(value.sourceTrack),
    translationTrack: parseTrack(value.translationTrack),
  }
}

export function parseSubtitleJobUpdate(value: unknown): SubtitleJobUpdate {
  if (!isRecord(value)) {
    throw new Error('Subtitle generation progress response is invalid.')
  }

  if ('jobId' in value) {
    return { kind: 'snapshot', job: parseSubtitleJob(value) }
  }

  const state = readJobState(value)
  const phase = readJobPhase(value)

  if (state !== 'running') {
    throw new Error(`Partial subtitle generation updates must be running, not ${state}.`)
  }

  return {
    kind: 'progress',
    progress: { state, phase },
  }
}

async function readGenerationApiError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json()

    if (isRecord(value) && typeof value.error === 'string' && value.error.length > 0) {
      return value.error
    }

    if (isRecord(value) && typeof value.message === 'string' && value.message.length > 0) {
      return value.message
    }
  } catch {
    return response.statusText || 'Request failed.'
  }

  return response.statusText || 'Request failed.'
}

export async function startSubtitleGeneration(
  options: StartSubtitleGenerationOptions,
  fetcher: Fetcher = fetch,
): Promise<SubtitleJob> {
  const sessionResponse = await fetcher('/api/subtitle-sessions', { method: 'POST' })

  if (!sessionResponse.ok) {
    throw new Error(await readGenerationApiError(sessionResponse))
  }

  const sessionValue: unknown = await sessionResponse.json()

  if (!isRecord(sessionValue) || typeof sessionValue.sessionId !== 'string') {
    throw new Error('Subtitle session response is invalid.')
  }

  const videoResponse = await fetcher(options.video.mediaUrl)

  if (!videoResponse.ok) {
    throw new Error(await readGenerationApiError(videoResponse))
  }

  const videoBlob = await videoResponse.blob()
  const form = new FormData()
  form.set('sessionId', sessionValue.sessionId)
  form.set(
    'video',
    new File([videoBlob], options.video.filename, {
      type: options.video.mimeType || videoBlob.type,
    }),
  )
  if (options.sourceLanguage) {
    form.set('sourceLanguage', options.sourceLanguage)
  }
  if (options.targetLanguage) {
    form.set('targetLanguage', options.targetLanguage)
  }
  form.set('qualityProfile', 'balanced')
  form.set('diarize', String(options.diarize))

  const response = await fetcher('/api/subtitle-jobs', { method: 'POST', body: form })
  const value: unknown = await response.json()

  if (!response.ok) {
    throw new Error(
      isRecord(value) && typeof value.message === 'string'
        ? value.message
        : await readGenerationApiError(new Response(JSON.stringify(value), {
            status: response.status,
            statusText: response.statusText,
            headers: { 'content-type': 'application/json' },
          })),
    )
  }

  return parseSubtitleJob(value)
}

async function fetchSubtitleJob(jobId: string, fetcher: Fetcher): Promise<SubtitleJob> {
  const response = await fetcher(`/api/subtitle-jobs/${jobId}`)

  if (!response.ok) {
    throw new Error(await readGenerationApiError(response))
  }

  return parseSubtitleJob(await response.json())
}

const browserEventSourceFactory = (url: string) =>
  new EventSource(url) as unknown as SubtitleEventSource

export function subscribeSubtitleJob(
  jobId: string,
  onUpdate: (update: SubtitleJobUpdate) => void,
  options: SubscribeSubtitleJobOptions = {},
): SubtitleJobSubscription {
  const fetcher = options.fetcher ?? fetch
  const events = (options.eventSourceFactory ?? browserEventSourceFactory)(
    `/api/subtitle-jobs/${jobId}/events`,
  )

  events.addEventListener('progress', (event) => {
    try {
      onUpdate(parseSubtitleJobUpdate(JSON.parse(event.data) as unknown))
    } catch {
      options.onProtocolError?.()
    }
  })

  events.onerror = () => {
    events.close()
    void fetchSubtitleJob(jobId, fetcher)
      .then((job) => onUpdate({ kind: 'snapshot', job }))
      .catch(() => options.onProtocolError?.())
  }

  return { close: () => events.close() }
}
