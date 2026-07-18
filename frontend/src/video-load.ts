import {
  parseTimelineText,
  type TimelineTextFormat,
  type TimelineTextItemData,
} from '@moritzbrantner/timeline-editor/text'
import type { SubtitleAsset } from './subtitle-session'

export type LoadWarning = {
  filename: string
  message: string
}

export type LoadedVideo = {
  id: string
  filename: string
  stem: string
  mediaUrl: string
  mimeType: string
}

type LoadedSubtitle = {
  id: string
  filename: string
  infixTitle: string
  mediaUrl: string
  textUrl: string
  format: string
  mimeType: string
}

export type VideoLoadResponse = {
  loadId: string
  video: LoadedVideo
  subtitles: LoadedSubtitle[]
  warnings: LoadWarning[]
}

export type VideoPickResult =
  | { status: 'cancelled' }
  | { status: 'loaded'; load: VideoLoadResponse }

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]

  if (typeof value !== 'string') {
    throw new Error('Backend returned an invalid video load response.')
  }

  return value
}

function parseLoadedVideo(value: unknown): LoadedVideo {
  if (!isRecord(value)) {
    throw new Error('Backend returned an invalid video load response.')
  }

  return {
    id: readString(value, 'id'),
    filename: readString(value, 'filename'),
    stem: readString(value, 'stem'),
    mediaUrl: readString(value, 'mediaUrl'),
    mimeType: readString(value, 'mimeType'),
  }
}

function parseLoadedSubtitle(value: unknown): LoadedSubtitle {
  if (!isRecord(value)) {
    throw new Error('Backend returned an invalid video load response.')
  }

  return {
    id: readString(value, 'id'),
    filename: readString(value, 'filename'),
    infixTitle: readString(value, 'infixTitle'),
    mediaUrl: readString(value, 'mediaUrl'),
    textUrl: readString(value, 'textUrl'),
    format: readString(value, 'format'),
    mimeType: readString(value, 'mimeType'),
  }
}

function parseLoadWarning(value: unknown): LoadWarning {
  if (!isRecord(value)) {
    throw new Error('Backend returned an invalid video load response.')
  }

  return {
    filename: readString(value, 'filename'),
    message: readString(value, 'message'),
  }
}

function parseVideoLoadResponse(value: unknown): VideoLoadResponse {
  if (!isRecord(value) || !Array.isArray(value.subtitles) || !Array.isArray(value.warnings)) {
    throw new Error('Backend returned an invalid video load response.')
  }

  return {
    loadId: readString(value, 'loadId'),
    video: parseLoadedVideo(value.video),
    subtitles: value.subtitles.map(parseLoadedSubtitle),
    warnings: value.warnings.map(parseLoadWarning),
  }
}

export async function readApiError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json()

    if (isRecord(value) && typeof value.error === 'string' && value.error.length > 0) {
      return value.error
    }
  } catch {
    return response.statusText || 'Request failed.'
  }

  return response.statusText || 'Request failed.'
}

export async function requestVideoPick(fetcher: Fetch = fetch): Promise<VideoPickResult> {
  const response = await fetcher('/api/video-picks', { method: 'POST' })

  if (response.status === 204) {
    return { status: 'cancelled' }
  }

  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const value: unknown = await response.json()

  return { status: 'loaded', load: parseVideoLoadResponse(value) }
}

function toTimelineTextFormat(format: string): TimelineTextFormat | undefined {
  switch (format) {
    case 'ass':
    case 'ssa':
    case 'srt':
    case 'webvtt':
      return format
    default:
      return undefined
  }
}

function lastCueEndMs(data: TimelineTextItemData): number {
  return Math.max(0, ...(data.cues ?? []).map((cue) => cue.endMs))
}

async function loadSubtitleAsset(
  subtitle: LoadedSubtitle,
  videoDurationMs: number,
  fetcher: Fetch,
): Promise<{ asset?: SubtitleAsset; warnings: LoadWarning[] }> {
  let response: Response

  try {
    response = await fetcher(subtitle.textUrl)
  } catch (error) {
    return {
      warnings: [
        {
          filename: subtitle.filename,
          message: error instanceof Error ? error.message : 'subtitle file could not be read',
        },
      ],
    }
  }

  if (!response.ok) {
    return {
      warnings: [{ filename: subtitle.filename, message: await readApiError(response) }],
    }
  }

  const text = await response.text()

  try {
    const parsed = parseTimelineText(text, {
      format: toTimelineTextFormat(subtitle.format),
      sourceLabel: subtitle.filename,
      mimeType: subtitle.mimeType,
    })
    const warnings = (parsed.warnings ?? []).map((message) => ({
      filename: subtitle.filename,
      message,
    }))

    if (parsed.cues.length === 0) {
      return {
        warnings: [
          ...warnings,
          { filename: subtitle.filename, message: 'subtitle file has no cues' },
        ],
      }
    }

    const data: TimelineTextItemData = {
      mediaType: 'text',
      format: parsed.format,
      text,
      cues: parsed.cues,
      styles: parsed.styles,
      source: {
        id: subtitle.id,
        uri: subtitle.mediaUrl,
        label: subtitle.filename,
        mimeType: subtitle.mimeType,
      },
    }

    return {
      asset: {
        id: subtitle.id,
        label: subtitle.infixTitle,
        kind: 'text',
        mediaType: 'text',
        durationMs: Math.max(lastCueEndMs(data), videoDurationMs),
        color: '#2fbf71',
        data,
      },
      warnings,
    }
  } catch (error) {
    return {
      warnings: [
        {
          filename: subtitle.filename,
          message: error instanceof Error ? error.message : 'subtitle file could not be parsed',
        },
      ],
    }
  }
}

export async function loadSubtitleAssets(
  load: VideoLoadResponse,
  videoDurationMs: number,
  fetcher: Fetch = fetch,
): Promise<{ assets: SubtitleAsset[]; warnings: LoadWarning[] }> {
  const results = await Promise.all(
    load.subtitles.map((subtitle) => loadSubtitleAsset(subtitle, videoDurationMs, fetcher)),
  )

  return {
    assets: results.flatMap((result) => (result.asset ? [result.asset] : [])),
    warnings: [...load.warnings, ...results.flatMap((result) => result.warnings)],
  }
}
