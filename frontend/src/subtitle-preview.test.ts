import { describe, expect, it } from 'vitest'
import type { SubtitleDocument } from './subtitle-session'
import { getActiveSubtitlePreviewCues } from './subtitle-preview'

function createDocument(): SubtitleDocument {
  return {
    durationMs: 10_000,
    currentTimeMs: 0,
    tracks: [
      {
        id: 'subtitle-en',
        label: 'English',
        kind: 'text',
        items: [
          {
            id: 'english-item',
            trackId: 'subtitle-en',
            label: 'English',
            startMs: 1_000,
            durationMs: 4_000,
            kind: 'text',
            data: {
              mediaType: 'text',
              styles: [
                {
                  name: 'Default',
                  alignment: 'top-center',
                  color: '#ffffff',
                },
              ],
              cues: [
                {
                  id: 'cue-1',
                  startMs: 500,
                  endMs: 1_500,
                  text: 'Original subtitle',
                  styleName: 'Default',
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

describe('getActiveSubtitlePreviewCues', () => {
  it('uses the edited timeline item offset when selecting visible cues', () => {
    const document = createDocument()

    expect(getActiveSubtitlePreviewCues(document, 1_499)).toEqual([])

    const active = getActiveSubtitlePreviewCues(document, 1_500)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
      trackId: 'subtitle-en',
      trackLabel: 'English',
      alignment: 'top-center',
      cue: { id: 'cue-1', text: 'Original subtitle' },
    })

    document.tracks[0]!.items[0]!.startMs = 2_000
    expect(getActiveSubtitlePreviewCues(document, 1_500)).toEqual([])
    expect(getActiveSubtitlePreviewCues(document, 2_500)).toHaveLength(1)
  })

  it('reads cue edits directly from the live document and combines active subtitle tracks', () => {
    const document = createDocument()
    const englishData = document.tracks[0]!.items[0]!.data

    if (englishData?.mediaType === 'text') {
      englishData.cues![0]!.text = 'Edited subtitle'
    }

    document.tracks.push({
      id: 'subtitle-de',
      label: 'German',
      kind: 'text',
      items: [
        {
          id: 'german-item',
          trackId: 'subtitle-de',
          label: 'German',
          startMs: 0,
          durationMs: 5_000,
          kind: 'text',
          data: {
            mediaType: 'text',
            cues: [{ startMs: 1_500, endMs: 2_500, text: 'Deutscher Untertitel' }],
          },
        },
      ],
    })

    expect(getActiveSubtitlePreviewCues(document, 1_750).map(({ cue }) => cue.text)).toEqual([
      'Edited subtitle',
      'Deutscher Untertitel',
    ])
  })
})
