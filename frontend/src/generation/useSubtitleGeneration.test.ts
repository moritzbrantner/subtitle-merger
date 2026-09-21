import { describe, expect, it, vi } from 'vitest'
import { getMessages } from '../localization'
import type { SubtitleJob, SubtitleJobUpdate } from './types'
import {
  buildGeneratedSubtitleAssets,
  createSubtitleGenerationController,
} from './useSubtitleGeneration'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

const queuedJob: SubtitleJob = {
  jobId: 'job-1',
  sessionId: 'session-1',
  state: 'queued',
  phase: 'queued',
  progress: 0,
  message: 'queued',
  sourceTrack: null,
  translationTrack: null,
}

const completedJob: SubtitleJob = {
  ...queuedJob,
  state: 'completed',
  phase: 'completed',
  progress: 100,
  sourceTrack: {
    language: 'en',
    pivoted: false,
    cues: [{ startMs: 500, endMs: 1_500, text: 'Generated subtitle' }],
  },
}

const generationOptions = {
  video: {
    filename: 'movie.webm',
    mediaUrl: '/api/movie',
    mimeType: 'video/webm',
  },
  diarize: false,
}

function callbacks() {
  return {
    onGeneratingChange: vi.fn(),
    onMessage: vi.fn(),
    onCompleted: vi.fn(),
  }
}

describe('subtitle generation controller', () => {
  it('owns the subscription lifecycle through terminal completion', async () => {
    let onUpdate: ((update: SubtitleJobUpdate) => void) | undefined
    const close = vi.fn()
    const controller = createSubtitleGenerationController({
      startSubtitleGeneration: vi.fn().mockResolvedValue(queuedJob),
      subscribeSubtitleJob: vi.fn((_jobId, update) => {
        onUpdate = update
        return { close }
      }),
    })
    const events = callbacks()

    await controller.generate(generationOptions, getMessages('en'), events)

    expect(events.onGeneratingChange).toHaveBeenNthCalledWith(1, true)
    expect(events.onGeneratingChange).toHaveBeenLastCalledWith(false)
    expect(onUpdate).toBeDefined()

    onUpdate?.({ kind: 'snapshot', job: completedJob })

    expect(close).toHaveBeenCalledOnce()
    expect(events.onCompleted).toHaveBeenCalledWith(completedJob)
  })

  it('closes the previous subscription before starting another job', async () => {
    const firstClose = vi.fn()
    const secondClose = vi.fn()
    let subscriptionIndex = 0
    const controller = createSubtitleGenerationController({
      startSubtitleGeneration: vi
        .fn()
        .mockResolvedValueOnce(queuedJob)
        .mockResolvedValueOnce({ ...queuedJob, jobId: 'job-2' }),
      subscribeSubtitleJob: vi.fn(() => {
        subscriptionIndex += 1
        return { close: subscriptionIndex === 1 ? firstClose : secondClose }
      }),
    })

    await controller.generate(generationOptions, getMessages('en'), callbacks())
    await controller.generate(generationOptions, getMessages('en'), callbacks())

    expect(firstClose).toHaveBeenCalledOnce()
    expect(secondClose).not.toHaveBeenCalled()

    controller.dispose()
    expect(secondClose).toHaveBeenCalledOnce()
  })

  it('suppresses a pending start after cancellation', async () => {
    const pendingJob = deferred<SubtitleJob>()
    const subscribe = vi.fn()
    const controller = createSubtitleGenerationController({
      startSubtitleGeneration: vi.fn().mockReturnValue(pendingJob.promise),
      subscribeSubtitleJob: subscribe,
    })
    const events = callbacks()

    const generation = controller.generate(
      generationOptions,
      getMessages('en'),
      events,
    )
    controller.cancel()
    pendingJob.resolve(queuedJob)
    await generation

    expect(subscribe).not.toHaveBeenCalled()
    expect(events.onCompleted).not.toHaveBeenCalled()
  })
})

describe('buildGeneratedSubtitleAssets', () => {
  it('maps completed source tracks into editor assets deterministically', () => {
    const assets = buildGeneratedSubtitleAssets(
      completedJob,
      90_000,
      getMessages('en'),
      () => 'generated-id',
    )

    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({
      id: 'subtitles-generated-id',
      label: 'Subtitles — EN',
      durationMs: 90_000,
      kind: 'text',
      mediaType: 'text',
    })
  })
})
