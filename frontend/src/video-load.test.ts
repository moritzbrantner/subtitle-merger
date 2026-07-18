import { describe, expect, it } from 'vitest'
import { loadSubtitleAssets, requestVideoPick, type VideoLoadResponse } from './video-load'

const load: VideoLoadResponse = {
  loadId: 'load-1',
  video: {
    id: 'video-1',
    filename: 'movie.webm',
    stem: 'movie',
    mediaUrl: '/api/media/video-1',
    mimeType: 'video/webm',
  },
  subtitles: [
    {
      id: 'subtitle-1',
      filename: 'movie.en.srt',
      infixTitle: 'en',
      mediaUrl: '/api/media/subtitle-1',
      textUrl: '/api/subtitles/subtitle-1',
      format: 'srt',
      mimeType: 'application/x-subrip',
    },
  ],
  warnings: [],
}

describe('requestVideoPick', () => {
  it('validates and returns a backend-owned video pick', async () => {
    const result = await requestVideoPick(async () => Response.json(load))

    expect(result).toEqual({ status: 'loaded', load })
  })

  it('represents a cancelled native picker without an error', async () => {
    const result = await requestVideoPick(async () => new Response(null, { status: 204 }))

    expect(result).toEqual({ status: 'cancelled' })
  })
})

describe('loadSubtitleAssets', () => {
  it('parses each Subtitle Sibling into an editable text asset', async () => {
    const result = await loadSubtitleAssets(load, 90_000, async () =>
      new Response('1\n00:00:01,000 --> 00:00:03,000\nOgres are like onions.\n'),
    )

    expect(result.warnings).toEqual([])
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0]).toMatchObject({
      id: 'subtitle-1',
      label: 'en',
      kind: 'text',
      durationMs: 90_000,
      data: {
        mediaType: 'text',
        cues: [{ startMs: 1_000, endMs: 3_000, text: 'Ogres are like onions.' }],
      },
    })
  })
})
