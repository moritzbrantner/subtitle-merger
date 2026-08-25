import type { TimelineTextItemData } from '@moritzbrantner/timeline-editor/text'
import type { SubtitleDocument } from './subtitle-session'

export type SubtitleExportFormat = 'srt' | 'webvtt'

export type SubtitleExport = {
  filename: string
  mimeType: string
  text: string
}

type EditableSubtitleTrack = {
  id: string
  label: string
  data: TimelineTextItemData
}

function subtitleData(document: SubtitleDocument, trackId: string): EditableSubtitleTrack {
  const track = document.tracks.find((candidate) => candidate.id === trackId)

  if (!track) {
    throw new Error(`Subtitle track ${trackId} does not exist.`)
  }

  const item = track.items.find((candidate) => candidate.data?.mediaType === 'text')

  if (!item?.data || !Array.isArray(item.data.cues)) {
    throw new Error(`Subtitle track ${trackId} has no editable cues.`)
  }

  return { id: track.id, label: track.label, data: item.data }
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

function normalizedCues(data: TimelineTextItemData) {
  return [...(data.cues ?? [])]
    .map((cue, sourceIndex) => ({
      ...cue,
      sourceIndex,
      startMs: Math.max(0, cue.startMs),
      endMs: Math.max(cue.startMs, cue.endMs),
      text: cue.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim(),
    }))
    .sort((left, right) =>
      left.startMs === right.startMs
        ? left.sourceIndex - right.sourceIndex
        : left.startMs - right.startMs,
    )
}

function serializeSrt(data: TimelineTextItemData): string {
  return normalizedCues(data)
    .map(
      (cue, index) =>
        `${index + 1}\n${timestamp(cue.startMs, ',')} --> ${timestamp(cue.endMs, ',')}\n${cue.text}`,
    )
    .join('\n\n') + '\n'
}

function serializeWebVtt(data: TimelineTextItemData): string {
  const body = normalizedCues(data)
    .map(
      (cue) =>
        `${timestamp(cue.startMs, '.')} --> ${timestamp(cue.endMs, '.')}\n${cue.text}`,
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
    const item = track.items.find((candidate) => candidate.data?.mediaType === 'text')

    if (!item?.data || !Array.isArray(item.data.cues)) {
      return []
    }

    return [{ id: track.id, label: track.label, language: item.data.language }]
  })
}

export function exportSubtitleTrack(
  document: SubtitleDocument,
  trackId: string,
  format: SubtitleExportFormat,
): SubtitleExport {
  const track = subtitleData(document, trackId)
  const languageSuffix = track.data.language ? `-${safeFilenamePart(track.data.language)}` : ''
  const stem = `${safeFilenamePart(track.label)}${languageSuffix}`

  switch (format) {
    case 'srt':
      return {
        filename: `${stem}.srt`,
        mimeType: 'application/x-subrip;charset=utf-8',
        text: serializeSrt(track.data),
      }
    case 'webvtt':
      return {
        filename: `${stem}.vtt`,
        mimeType: 'text/vtt;charset=utf-8',
        text: serializeWebVtt(track.data),
      }
  }
}
