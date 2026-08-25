import { describe, expect, it } from 'vitest'
import { buildSubtitleSession, type SubtitleAsset } from './subtitle-session'
import { exportSubtitleTrack, listEditableSubtitleTracks } from './subtitle-export'

function session() {
  const asset: SubtitleAsset = {
    id: 'generated-de',
    label: 'Translation',
    kind: 'text',
    mediaType: 'text',
    durationMs: 5_000,
    data: {
      mediaType: 'text',
      format: 'webvtt',
      language: 'de',
      cues: [
        { id: 'second', startMs: 2_000, endMs: 3_250, text: 'Zweite Zeile' },
        { id: 'first', startMs: 250, endMs: 1_500, text: 'Original text' },
      ],
    },
  }

  return buildSubtitleSession(5_000, [asset])
}

describe('subtitle export', () => {
  it('serializes the edited timeline state instead of the original source text', () => {
    const current = session()
    const data = current.document.tracks[0]?.items[0]?.data
    const cues = data?.cues

    expect(cues).toBeDefined()
    if (!cues) return
    cues[1]!.text = 'Edited subtitle'

    const exported = exportSubtitleTrack(current.document, 'subtitle-generated-de', 'srt')

    expect(exported.filename).toBe('translation-de.srt')
    expect(exported.text).toBe(
      '1\n00:00:00,250 --> 00:00:01,500\nEdited subtitle\n\n' +
        '2\n00:00:02,000 --> 00:00:03,250\nZweite Zeile\n',
    )
  })

  it('writes WebVTT with stable chronological cue order', () => {
    const current = session()
    const exported = exportSubtitleTrack(current.document, 'subtitle-generated-de', 'webvtt')

    expect(exported.mimeType).toBe('text/vtt;charset=utf-8')
    expect(exported.text).toBe(
      'WEBVTT\n\n' +
        '00:00:00.250 --> 00:00:01.500\nOriginal text\n\n' +
        '00:00:02.000 --> 00:00:03.250\nZweite Zeile\n',
    )
  })

  it('lists editable tracks with their language', () => {
    const current = session()

    expect(listEditableSubtitleTracks(current.document)).toEqual([
      { id: 'subtitle-generated-de', label: 'Translation', language: 'de' },
    ])
  })

  it('rejects an unknown track instead of exporting stale data', () => {
    const current = session()

    expect(() => exportSubtitleTrack(current.document, 'missing', 'srt')).toThrow(
      'Subtitle track missing does not exist.',
    )
  })
})
