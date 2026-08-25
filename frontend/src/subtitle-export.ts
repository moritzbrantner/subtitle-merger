import type { SubtitleDocument } from './subtitle-session'

export type SubtitleExportFormat = 'srt' | 'webvtt'

export type SubtitleExport = {
  filename: string
  mimeType: string
  text: string
}

type ExportCue = {
  startMs: number
  endMs: number
  text: string
  actor?: string
  sourceOrder: number
}

type EditableSubtitleTrack = {
  id: string
  label: string
  language?: string
  cues: ExportCue[]
}

function subtitleData(document: SubtitleDocument, trackId: string): EditableSubtitleTrack {
  const track = document.tracks.find((candidate) => candidate.id === trackId)

  if (!track) {
    throw new Error(`Subtitle track ${trackId} does not exist.`)
  }

  const items = track.items.filter(
    (candidate) => candidate.data?.mediaType === 'text' && Array.isArray(candidate.data.cues),
  )

  if (items.length === 0) {
    throw new Error(`Subtitle track ${trackId} has no editable cues.`)
  }

  const cues = items.flatMap((item, itemIndex) => {
    const placementMs = item.startMs ?? 0

    return (item.data?.cues ?? []).map((cue, cueIndex) => ({
      startMs: placementMs + cue.startMs,
      endMs: placementMs + cue.endMs,
      text: cue.text,
      actor: cue.actor?.trim() || undefined,
      sourceOrder: itemIndex * 1_000_000 + cueIndex,
    }))
  })

  return {
    id: track.id,
    label: track.label,
    language: items.find((item) => item.data?.language)?.data?.language,
    cues,
  }
}

function timestamp(milliseconds: number, separator: ',' | '.'): string {
  const value = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor((value % 3_600_000) / 60_000)
  const seconds = Math.floor((value % 60_000) / 1_000)
  const millis = value % 1_000

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':') + `${separator}${String(millis).padStart(3, '0')}`
}

function normalizedCues(cues: ExportCue[]) {
  return cues
    .map((cue) => ({
      ...cue,
      startMs: Math.max(0, cue.startMs),
      endMs: Math.max(cue.startMs, cue.endMs),
      text: cue.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim(),
    }))
    .sort((left, right) =>
      left.startMs === right.startMs
        ? left.sourceOrder - right.sourceOrder
        : left.startMs - right.startMs,
    )
}

function srtCueText(cue: ExportCue): string {
  return cue.actor ? `${cue.actor}: ${cue.text}` : cue.text
}

function webVttVoice(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function webVttCueText(cue: ExportCue): string {
  return cue.actor ? `<v ${webVttVoice(cue.actor)}>${cue.text}` : cue.text
}

function serializeSrt(cues: ExportCue[]): string {
  return normalizedCues(cues)
    .map(
      (cue, index) =>
        `${index + 1}\n${timestamp(cue.startMs, ',')} --> ${timestamp(cue.endMs, ',')}\n${srtCueText(cue)}`,
    )
    .join('\n\n') + '\n'
}

function serializeWebVtt(cues: ExportCue[]): string {
  const body = normalizedCues(cues)
    .map(
      (cue) =>
        `${timestamp(cue.startMs, '.')} --> ${timestamp(cue.endMs, '.')}\n${webVttCueText(cue)}`,
    )
    .join('\n\n')

  return `WEBVTT\n\n${body}${body ? '\n' : ''}`
}

function safeFilenamePart(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  return normalized || 'subtitles'
}

export function listEditableSubtitleTracks(
  document: SubtitleDocument,
): Array<{ id: string; label: string; language?: string }> {
  return document.tracks.flatMap((track) => {
    const items = track.items.filter(
      (candidate) => candidate.data?.mediaType === 'text' && Array.isArray(candidate.data.cues),
    )

    if (items.length === 0) {
      return []
    }

    return [
      {
        id: track.id,
        label: track.label,
        language: items.find((item) => item.data?.language)?.data?.language,
      },
    ]
  })
}

export function exportSubtitleTrack(
  document: SubtitleDocument,
  trackId: string,
  format: SubtitleExportFormat,
): SubtitleExport {
  const track = subtitleData(document, trackId)
  const languageSuffix = track.language ? `-${safeFilenamePart(track.language)}` : ''
  const stem = `${safeFilenamePart(track.label)}${languageSuffix}`

  switch (format) {
    case 'srt':
      return {
        filename: `${stem}.srt`,
        mimeType: 'application/x-subrip;charset=utf-8',
        text: serializeSrt(track.cues),
      }
    case 'webvtt':
      return {
        filename: `${stem}.vtt`,
        mimeType: 'text/vtt;charset=utf-8',
        text: serializeWebVtt(track.cues),
      }
  }
}
