import { describe, expect, it, vi } from 'vitest'
import { loadReferenceVideoAudio } from './reference-video-audio'

const source = {
  filename: 'movie.webm',
  mediaUrl: '/api/movie',
  mimeType: 'video/webm',
}

describe('loadReferenceVideoAudio', () => {
  it('delegates decoding and waveform generation to timeline-editor/audio', async () => {
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/webm' },
      }),
    )
    const metadataLoader = vi.fn(async () => ({
      waveform: [0, 0.5, 1],
      channels: 2,
      sampleRate: 48_000,
    }))

    const result = await loadReferenceVideoAudio(source, { fetcher, metadataLoader })

    expect(fetcher).toHaveBeenCalledWith('/api/movie', { signal: undefined })
    expect(metadataLoader).toHaveBeenCalledTimes(1)
    const [file, options] = metadataLoader.mock.calls[0]!
    expect(file.name).toBe('movie.webm')
    expect(file.type).toBe('video/webm')
    expect(options).toEqual({ sampleCount: 512, normalize: true })
    expect(result).toEqual({
      label: 'movie.webm',
      waveform: [0, 0.5, 1],
      channels: 2,
      sampleRate: 48_000,
    })
  })

  it('fails closed when the shared audio contract cannot produce a waveform', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }))
    const metadataLoader = vi.fn(async () => ({ channels: 1 }))

    await expect(
      loadReferenceVideoAudio(source, { fetcher, metadataLoader }),
    ).rejects.toThrow('Reference video audio could not be decoded.')
  })

  it('does not invoke shared decoding when the media transport fails', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }))
    const metadataLoader = vi.fn(async () => ({ waveform: [1] }))

    await expect(
      loadReferenceVideoAudio(source, { fetcher, metadataLoader }),
    ).rejects.toThrow('Reference video audio could not be read (503).')
    expect(metadataLoader).not.toHaveBeenCalled()
  })

  it('forwards cancellation to the media fetch without inventing decoder cancellation', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return new Response(new Uint8Array([1]), { status: 200 })
    })
    const metadataLoader = vi.fn(async () => ({ waveform: [0] }))

    await loadReferenceVideoAudio(source, {
      fetcher,
      metadataLoader,
      signal: controller.signal,
      sampleCount: 64,
    })

    expect(metadataLoader).toHaveBeenCalledWith(expect.any(File), {
      sampleCount: 64,
      normalize: true,
    })
  })
})
