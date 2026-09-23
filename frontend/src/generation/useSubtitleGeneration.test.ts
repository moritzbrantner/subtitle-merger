import { describe, expect, it, vi } from 'vitest'
import { getMessages } from '../localization'
import type { SubtitleJob, SubtitleJobUpdate } from './types'
import { buildGeneratedSubtitleAssets, createSubtitleGenerationController } from './useSubtitleGeneration'

const queuedJob: SubtitleJob = {
  jobId: 'job-1', sessionId: 'session-1', state: 'queued', phase: 'queued', progress: 0,
  message: 'queued', sourceTrack: null, translationTrack: null,
}
const completedJob: SubtitleJob = {
  ...queuedJob, state: 'completed', phase: 'completed', progress: 100,
  message: 'source subtitles generated; translation failed: offline',
  sourceTrack: { language: 'en', pivoted: false, cues: [{ startMs: 500, endMs: 1500, text: 'Generated subtitle' }] },
}
const generationOptions = {
  video: { id: 'video-1', filename: 'movie.webm', mediaUrl: '/api/movie', mimeType: 'video/webm' },
  diarize: false,
}
function callbacks() {
  return { onGeneratingChange: vi.fn(), onMessage: vi.fn(), onCompleted: vi.fn() }
}
function fixture() {
  let update!: (value: SubtitleJobUpdate) => void
  const close = vi.fn()
  const cancelSubtitleJob = vi.fn().mockResolvedValue(undefined)
  const startSubtitleGeneration = vi.fn().mockResolvedValue(queuedJob)
  const controller = createSubtitleGenerationController({
    startSubtitleGeneration, cancelSubtitleJob,
    subscribeSubtitleJob: vi.fn((_id, listener) => { update = listener; return { close } }),
  })
  return { controller, close, startSubtitleGeneration, cancelSubtitleJob, update: (value: SubtitleJobUpdate) => update(value) }
}

describe('subtitle generation controller', () => {
  it('stays busy through downloads and inference, then completes once with warnings intact', async () => {
    const f = fixture()
    const events = callbacks()
    await f.controller.generate(generationOptions, getMessages('en'), events)
    expect(events.onGeneratingChange).toHaveBeenCalledExactlyOnceWith(true)
    f.update({ kind: 'snapshot', job: { ...queuedJob, state: 'running', phase: 'downloadingModels' } })
    expect(events.onMessage).toHaveBeenLastCalledWith('Downloading required models…')
    expect(events.onGeneratingChange).toHaveBeenLastCalledWith(true)
    f.update({ kind: 'snapshot', job: completedJob })
    f.update({ kind: 'snapshot', job: completedJob })
    expect(f.close).toHaveBeenCalledOnce()
    expect(events.onGeneratingChange).toHaveBeenLastCalledWith(false)
    expect(events.onMessage).toHaveBeenLastCalledWith(completedJob.message)
    expect(events.onCompleted).toHaveBeenCalledExactlyOnceWith(completedJob)
  })

  it('releases busy state on a failed download and permits retry', async () => {
    const f = fixture()
    const events = callbacks()
    await f.controller.generate(generationOptions, getMessages('en'), events)
    f.update({ kind: 'snapshot', job: { ...queuedJob, state: 'failed', phase: 'failed', message: 'Disk full' } })
    expect(events.onGeneratingChange).toHaveBeenLastCalledWith(false)
    expect(events.onMessage).toHaveBeenLastCalledWith('Disk full')
    expect(events.onCompleted).not.toHaveBeenCalled()
    await f.controller.generate(generationOptions, getMessages('en'), events)
    expect(f.startSubtitleGeneration).toHaveBeenCalledTimes(2)
    expect(events.onGeneratingChange).toHaveBeenLastCalledWith(true)
    f.controller.dispose()
  })

  it('cancels the old backend job and closes its subscription when replaced', async () => {
    const f = fixture()
    await f.controller.generate(generationOptions, getMessages('en'), callbacks())
    await f.controller.generate(generationOptions, getMessages('en'), callbacks())
    expect(f.cancelSubtitleJob).toHaveBeenCalledWith('job-1')
    expect(f.close).toHaveBeenCalledOnce()
    f.controller.dispose()
    expect(f.close).toHaveBeenCalledTimes(2)
  })

  it('cancels a server job accepted while its startup view was cancelled', async () => {
    let resolve!: (value: SubtitleJob) => void
    const start = new Promise<SubtitleJob>((done) => { resolve = done })
    const subscribe = vi.fn()
    const cancelSubtitleJob = vi.fn().mockResolvedValue(undefined)
    const controller = createSubtitleGenerationController({
      startSubtitleGeneration: vi.fn().mockReturnValue(start),
      subscribeSubtitleJob: subscribe, cancelSubtitleJob,
    })
    const events = callbacks()
    const pending = controller.generate(generationOptions, getMessages('en'), events)
    controller.cancel()
    resolve(queuedJob)
    await pending
    expect(subscribe).not.toHaveBeenCalled()
    expect(events.onCompleted).not.toHaveBeenCalled()
    expect(cancelSubtitleJob).toHaveBeenCalledWith('job-1')
  })

  it('handles an already completed POST without subscribing', async () => {
    const subscribe = vi.fn()
    const controller = createSubtitleGenerationController({
      startSubtitleGeneration: vi.fn().mockResolvedValue(completedJob), subscribeSubtitleJob: subscribe,
    })
    const events = callbacks()
    await controller.generate(generationOptions, getMessages('en'), events)
    expect(subscribe).not.toHaveBeenCalled()
    expect(events.onCompleted).toHaveBeenCalledOnce()
    expect(events.onGeneratingChange).toHaveBeenLastCalledWith(false)
  })

  it('closes a synchronous terminal replay without leaking the new subscription', async () => {
    const close = vi.fn()
    const controller = createSubtitleGenerationController({
      startSubtitleGeneration: vi.fn().mockResolvedValue(queuedJob),
      subscribeSubtitleJob: vi.fn((_id, update) => {
        update({ kind: 'snapshot', job: completedJob })
        return { close }
      }),
    })
    const events = callbacks()
    await controller.generate(generationOptions, getMessages('en'), events)
    expect(close).toHaveBeenCalledOnce()
    expect(events.onCompleted).toHaveBeenCalledOnce()
  })

  it('maps generated tracks into editor assets deterministically', () => {
    const assets = buildGeneratedSubtitleAssets(completedJob, 90000, getMessages('en'), () => 'generated-id')
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({
      id: 'subtitles-generated-id', label: 'Subtitles — EN', durationMs: 90000, kind: 'text', mediaType: 'text',
    })
  })
})
