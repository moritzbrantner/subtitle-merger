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
  id?: string
  filename: string
  mediaUrl: string
  mimeType: string
}

export type StartSubtitleGenerationOptions = {
  video: GenerationVideo
  targetLanguage?: string
  diarize: boolean
  sourceLanguage?: string
  signal?: AbortSignal
}

export type SubtitleJobSubscription = {
  close: () => void
}

export type GenerationPreflight = {
  ready: boolean
  cacheDir: string
  modelDownloadsAutomatic: boolean
  diarizationAvailable: boolean
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
  onFatalError?: (message: string) => void
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
  if (!isRecord(value)) throw new Error('Subtitle generation response has an invalid cue.')
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
  if (value === null || value === undefined) return null
  if (!isRecord(value) || typeof value.pivoted !== 'boolean' || !Array.isArray(value.cues)) {
    throw new Error('Subtitle generation response has an invalid track.')
  }
  return { language: readString(value, 'language'), pivoted: value.pivoted, cues: value.cues.map(parseCue) }
}

export function parseSubtitleJob(value: unknown): SubtitleJob {
  if (!isRecord(value)) throw new Error('Subtitle generation response is invalid.')
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
  if (!isRecord(value)) throw new Error('Subtitle generation progress response is invalid.')
  if ('jobId' in value) return { kind: 'snapshot', job: parseSubtitleJob(value) }
  const state = readJobState(value)
  const phase = readJobPhase(value)
  if (state !== 'running') {
    throw new Error(`Partial subtitle generation updates must be running, not ${state}.`)
  }
  return { kind: 'progress', progress: { state, phase } }
}

async function readGenerationApiError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json()
    if (isRecord(value) && typeof value.error === 'string' && value.error.length > 0) return value.error
    if (isRecord(value) && typeof value.message === 'string' && value.message.length > 0) return value.message
  } catch {
    return response.statusText || 'Request failed.'
  }
  return response.statusText || 'Request failed.'
}

export async function fetchGenerationPreflight(fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<GenerationPreflight> {
  let response: Response
  try {
    response = await fetcher('/api/generation-preflight', { signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error('Could not reach the local backend. Start Subtitle Merger with bun start and retry.')
  }
  if (!response.ok) throw new Error(await readGenerationApiError(response))
  const value: unknown = await response.json()
  if (!isRecord(value) || typeof value.ready !== 'boolean' || typeof value.cacheDir !== 'string'
    || typeof value.modelDownloadsAutomatic !== 'boolean' || typeof value.diarizationAvailable !== 'boolean') {
    throw new Error('The generation readiness response is invalid. Restart the backend and editor together with bun start.')
  }
  return {
    ready: value.ready,
    cacheDir: value.cacheDir,
    modelDownloadsAutomatic: value.modelDownloadsAutomatic,
    diarizationAvailable: value.diarizationAvailable,
  }
}

export async function cancelSubtitleJob(jobId: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`/api/subtitle-jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new Error(await readGenerationApiError(response))
}

export async function deleteSubtitleSession(sessionId: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`/api/subtitle-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new Error(await readGenerationApiError(response))
}

export async function startSubtitleGeneration(
  options: StartSubtitleGenerationOptions,
  fetcher: Fetcher = fetch,
): Promise<SubtitleJob> {
  const readiness = await fetchGenerationPreflight(fetcher, options.signal)
  if (!readiness.ready) {
    throw new Error('FFmpeg or ffprobe is missing. Restart with bun start to download the missing tools automatically, then retry.')
  }
  if (options.diarize && !readiness.diarizationAvailable) {
    throw new Error('Speaker identification is not available in this build. Turn off Identify speakers and retry.')
  }
  const sessionResponse = await fetcher('/api/subtitle-sessions', { method: 'POST' })
  if (!sessionResponse.ok) throw new Error(await readGenerationApiError(sessionResponse))
  const sessionValue: unknown = await sessionResponse.json()
  if (!isRecord(sessionValue) || typeof sessionValue.sessionId !== 'string') {
    throw new Error('Subtitle session response is invalid.')
  }
  const sessionId = sessionValue.sessionId
  try {
    options.signal?.throwIfAborted()
    const form = new FormData()
    form.set('sessionId', sessionId)
    if (options.video.id) {
      // The backend already owns this local video. Do not materialize and upload it again.
      form.set('mediaId', options.video.id)
    } else {
      const videoResponse = await fetcher(options.video.mediaUrl, { signal: options.signal })
      if (!videoResponse.ok) throw new Error(await readGenerationApiError(videoResponse))
      const videoBlob = await videoResponse.blob()
      form.set('video', new File([videoBlob], options.video.filename, { type: options.video.mimeType || videoBlob.type }))
    }
    if (options.sourceLanguage) form.set('sourceLanguage', options.sourceLanguage)
    if (options.targetLanguage) form.set('targetLanguage', options.targetLanguage)
    form.set('qualityProfile', 'balanced')
    form.set('diarize', String(options.diarize))
    options.signal?.throwIfAborted()
    // Receive the committed job ID even if the view is cancelled during POST.
    // The controller then cancels that exact server job instead of orphaning it.
    const response = await fetcher('/api/subtitle-jobs', { method: 'POST', body: form })
    if (!response.ok) throw new Error(await readGenerationApiError(response))
    return parseSubtitleJob(await response.json())
  } catch (error) {
    // Cleanup is deliberately not tied to the aborted upload signal.
    await deleteSubtitleSession(sessionId, fetcher).catch(() => undefined)
    throw error
  }
}

export function isTerminalJob(job: SubtitleJob): boolean {
  return job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed'
}

const browserEventSourceFactory = (url: string) => new EventSource(url) as unknown as SubtitleEventSource

export function subscribeSubtitleJob(
  jobId: string,
  onUpdate: (update: SubtitleJobUpdate) => void,
  options: SubscribeSubtitleJobOptions = {},
): SubtitleJobSubscription {
  const fetcher = options.fetcher ?? fetch
  const url = `/api/subtitle-jobs/${encodeURIComponent(jobId)}`
  const events = (options.eventSourceFactory ?? browserEventSourceFactory)(`${url}/events`)
  const controller = new AbortController()
  let closed = false
  let polling = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const close = () => {
    if (closed) return
    closed = true
    events.close()
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
  }
  const deliver = (update: SubtitleJobUpdate) => {
    if (closed) return
    onUpdate(update)
    if (update.kind === 'snapshot' && isTerminalJob(update.job)) close()
  }
  const poll = async () => {
    try {
      const response = await fetcher(url, { signal: controller.signal })
      if (closed) return
      if (response.status === 404 || response.status === 410) {
        close()
        options.onFatalError?.('The subtitle job is no longer available. The backend may have restarted; retry generation.')
        return
      }
      if (!response.ok) throw new Error(await readGenerationApiError(response))
      deliver({ kind: 'snapshot', job: parseSubtitleJob(await response.json()) })
    } catch {
      if (!closed) options.onProtocolError?.()
    }
    if (!closed) timer = setTimeout(() => void poll(), 1000)
  }
  const startPolling = () => {
    if (closed || polling) return
    polling = true
    events.close()
    void poll()
  }
  events.addEventListener('progress', (event) => {
    if (closed || polling) return
    try {
      deliver(parseSubtitleJobUpdate(JSON.parse(event.data) as unknown))
    } catch {
      options.onProtocolError?.()
      startPolling()
    }
  })
  events.onerror = startPolling
  return { close }
}
