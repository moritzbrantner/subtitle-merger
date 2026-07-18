import { describe, expect, it } from 'vitest'
import { buildSubtitleSession, type SubtitleAsset } from './subtitle-session'

function subtitleAsset(
  id: string,
  label: string,
  cueEndMs: number,
): SubtitleAsset {
  return {
    id,
    label,
    kind: 'text',
    mediaType: 'text',
    durationMs: cueEndMs,
    color: '#2fbf71',
    data: {
      mediaType: 'text',
      cues: [{ id: `${id}-cue`, startMs: 0, endMs: cueEndMs, text: label }],
    },
  }
}

describe('buildSubtitleSession', () => {
  it('creates only labelled subtitle tracks for loaded Subtitle Siblings', () => {
    const session = buildSubtitleSession(90_000, [
      subtitleAsset('en', 'English', 10_000),
      subtitleAsset('de', 'German', 12_000),
    ])

    expect(session.assets.map((asset) => asset.kind)).toEqual(['text', 'text'])
    expect(session.document.tracks).toHaveLength(2)
    expect(session.document.tracks.map((track) => track.label)).toEqual(['English', 'German'])
    expect(session.document.tracks.flatMap((track) => track.items)).toHaveLength(2)
    expect(session.document.tracks.flatMap((track) => track.items).map((item) => item.kind)).toEqual([
      'text',
      'text',
    ])
    expect(session.selection.trackIds).toEqual(['subtitle-en', 'subtitle-de'])
    expect(session.document.durationMs).toBe(90_000)
  })

  it('extends the subtitle timeline for a cue that ends after the Reference Video', () => {
    const session = buildSubtitleSession(90_000, [subtitleAsset('en', 'English', 95_000)])

    expect(session.document.durationMs).toBe(95_000)
  })

  it('creates an empty subtitle-only session when no Subtitle Sibling is usable', () => {
    const session = buildSubtitleSession(90_000, [])

    expect(session.assets).toEqual([])
    expect(session.document.tracks).toEqual([])
    expect(session.selection).toEqual({ itemIds: [], anchorItemId: undefined, trackIds: [] })
    expect(session.document.durationMs).toBe(90_000)
  })
})
