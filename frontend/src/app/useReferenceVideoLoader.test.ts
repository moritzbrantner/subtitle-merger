import { describe, expect, it, vi } from 'vitest'
import { getMessages } from '../localization'
import type { ReferenceVideoAudio } from '../reference-video-audio'
import type { VideoLoadResponse } from '../video-load'
import { createReferenceVideoLoadController } from './useReferenceVideoLoader'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const videoLoad: VideoLoadResponse = {
  loadId: 'load-1',
  video: {
    id: 'video-1',
    filename: 'movie.webm',
    stem: 'movie',
    mediaUrl: '/api/movie',
    mimeType: 'video/webm',
  },
  subtitles: [],
  warnings: [],
}

const referenceAudio: ReferenceVideoAudio = {
  label: 'movie.webm',
  waveform: [0, 1, 0.5],
  channels: 1,
  sampleRate: 48_000,
}

function callbacks() {
  return {
    onStarted: vi.fn(),
    onSessionLoaded: vi.fn(),
    onReferenceAudioLoaded: vi.fn(),
    onReferenceAudioWarning: vi.fn(),
    onFailed: vi.fn(),
    onFinished: vi.fn(),
  }
}

describe('reference video load controller', () => {
  it('commits the session before attaching a late reference waveform', async () => {
    const audio = deferred<ReferenceVideoAudio>()
    const controller = createReferenceVideoLoadController({
      requestVideoLoad: vi.fn().mockResolvedValue(videoLoad),
      probeReferenceVideoMetadata: vi.fn().mockResolvedValue({ durationMs: 90_000 }),
      loadSubtitleAssets: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadReferenceVideoAudio: vi.fn().mockReturnValue(audio.promise),
    })
    const events = callbacks()

    await controller.load('/videos/movie.webm', getMessages('en'), events)

    expect(events.onSessionLoaded).toHaveBeenCalledOnce()
    expect(events.onReferenceAudioLoaded).not.toHaveBeenCalled()
    expect(events.onFinished).toHaveBeenCalledOnce()

    audio.resolve(referenceAudio)
    await Promise.resolve()

    expect(events.onReferenceAudioLoaded).toHaveBeenCalledWith(90_000, referenceAudio)
  })

  it('suppresses stale load results after cancellation', async () => {
    const pendingLoad = deferred<VideoLoadResponse>()
    const controller = createReferenceVideoLoadController({
      requestVideoLoad: vi.fn().mockReturnValue(pendingLoad.promise),
      probeReferenceVideoMetadata: vi.fn(),
      loadSubtitleAssets: vi.fn(),
      loadReferenceVideoAudio: vi.fn(),
    })
    const events = callbacks()

    const loading = controller.load('/videos/movie.webm', getMessages('en'), events)
    controller.cancel()
    pendingLoad.resolve(videoLoad)
    await loading

    expect(events.onSessionLoaded).not.toHaveBeenCalled()
    expect(events.onFailed).not.toHaveBeenCalled()
    expect(events.onFinished).not.toHaveBeenCalled()
  })

  it('aborts late waveform work when the active load is cancelled', async () => {
    let signal: AbortSignal | undefined
    const controller = createReferenceVideoLoadController({
      requestVideoLoad: vi.fn().mockResolvedValue(videoLoad),
      probeReferenceVideoMetadata: vi.fn().mockResolvedValue({ durationMs: 90_000 }),
      loadSubtitleAssets: vi.fn().mockResolvedValue({ assets: [], warnings: [] }),
      loadReferenceVideoAudio: vi.fn((_source, options) => {
        signal = options?.signal
        return new Promise<ReferenceVideoAudio>(() => {})
      }),
    })

    await controller.load('/videos/movie.webm', getMessages('en'), callbacks())
    expect(signal?.aborted).toBe(false)

    controller.cancel()

    expect(signal?.aborted).toBe(true)
  })
})
