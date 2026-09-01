import { describe, expect, it } from 'vitest'
import { loadSubtitleAssets, requestVideoLoad, type VideoLoadResponse } from './video-load'

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

describe('requestVideoLoad', () => {
  it('loads an absolute path through the backend path API', async () => {
    const result = await requestVideoLoad('  /media/movie.webm  ', async (input, init) => {
      expect(String(input)).toBe('/api/video-loads')
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/media/movie.webm' }),
      })
      return Response.json(load)
    })

    expect(result).toEqual(load)
  })

  it('surfaces a backend path validation error', async () => {
    await expect(
      requestVideoLoad('/missing/movie.webm', async () =>
        Response.json({ error: 'video path does not exist' }, { status: 400 }),
      ),
    ).rejects.toThrow('video path does not exist')
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

  it('keeps valid Subtitle Siblings when another sibling fails to load', async () => {
    const mixedLoad: VideoLoadResponse = {
      ...load,
      subtitles: [
        load.subtitles[0]!,
        {
          id: 'subtitle-broken',
          filename: 'movie.de.srt',
          infixTitle: 'de',
          mediaUrl: '/api/media/subtitle-broken',
          textUrl: '/api/subtitles/subtitle-broken',
          format: 'srt',
          mimeType: 'application/x-subrip',
        },
      ],
    }

    const result = await loadSubtitleAssets(mixedLoad, 90_000, async (input) => {
      if (String(input).endsWith('/subtitle-broken')) {
        return Response.json({ error: 'subtitle file could not be read' }, { status: 500 })
      }

      return new Response('1\n00:00:01,000 --> 00:00:03,000\nOgres are like onions.\n')
    })

    expect(result.assets.map((asset) => asset.id)).toEqual(['subtitle-1'])
    expect(result.warnings).toEqual([
      { filename: 'movie.de.srt', message: 'subtitle file could not be read' },
    ])
  })
})
