import {
  loadTimelineAudioMetadata,
  type TimelineAudioMetadata,
} from '@moritzbrantner/timeline-editor/audio'

export type ReferenceVideoAudio = {
  label: string
  waveform: number[]
  channels?: number
  sampleRate?: number
}

type ReferenceVideoAudioSource = {
  filename: string
  mediaUrl: string
  mimeType: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type MetadataLoader = (
  file: File,
  options?: { sampleCount?: number; normalize?: boolean },
) => Promise<TimelineAudioMetadata>

export type LoadReferenceVideoAudioOptions = {
  fetcher?: Fetcher
  metadataLoader?: MetadataLoader
  sampleCount?: number
  signal?: AbortSignal
}

export async function loadReferenceVideoAudio(
  source: ReferenceVideoAudioSource,
  options: LoadReferenceVideoAudioOptions = {},
): Promise<ReferenceVideoAudio> {
  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(source.mediaUrl, { signal: options.signal })

  if (!response.ok) {
    throw new Error(`Reference video audio could not be read (${response.status}).`)
  }

  const blob = await response.blob()
  const file = new File([blob], source.filename, {
    type: source.mimeType || blob.type || 'application/octet-stream',
  })
  const metadata = await (options.metadataLoader ?? loadTimelineAudioMetadata)(file, {
    sampleCount: options.sampleCount ?? 512,
    normalize: true,
  })

  if (!metadata.waveform?.length) {
    throw new Error('Reference video audio could not be decoded.')
  }

  return {
    label: source.filename,
    waveform: metadata.waveform,
    channels: metadata.channels,
    sampleRate: metadata.sampleRate,
  }
}
