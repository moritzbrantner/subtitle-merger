import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMessages, supportedLocales } from '../localization'
import { startSubtitleGeneration, subscribeSubtitleJob } from './client'
import { subtitleJobPhases } from './types'

const queued = { jobId: 'job', sessionId: 'session', state: 'queued', phase: 'queued', progress: 0, message: '', sourceTrack: null, translationTrack: null }
const ready = { ready: true, cacheDir: '/cache', modelDownloadsAutomatic: true, diarizationAvailable: false }
const options = { video: { id: 'video', filename: 'movie.mp4', mimeType: 'video/mp4', mediaUrl: '/api/media/video' }, diarize: false }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

afterEach(() => vi.useRealTimers())

describe('first use generation', () => {
  it('checks readiness and submits the opened media ID without fetching the video', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(ready))
      .mockResolvedValueOnce(json({ sessionId: 'session' }))
      .mockResolvedValueOnce(json(queued))
    await expect(startSubtitleGeneration(options, fetcher)).resolves.toMatchObject(queued)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/generation-preflight', '/api/subtitle-sessions', '/api/subtitle-jobs'])
    const form = fetcher.mock.calls[2][1]?.body as FormData
    expect(form.get('mediaId')).toBe('video')
    expect(form.has('video')).toBe(false)
  })

  it('missing FFmpeg fails before creating a session or moving media', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...ready, ready: false }))
    await expect(startSubtitleGeneration(options, fetcher)).rejects.toThrow('bun start')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not claim unsupported speaker identification is runnable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(ready))
    await expect(startSubtitleGeneration({ ...options, diarize: true }, fetcher)).rejects.toThrow('not available')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('cleans up a session when job creation fails', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(ready))
      .mockResolvedValueOnce(json({ sessionId: 'session' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'already active' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(startSubtitleGeneration(options, fetcher)).rejects.toThrow('already active')
    expect(fetcher).toHaveBeenLastCalledWith('/api/subtitle-sessions/session', { method: 'DELETE' })
  })

  it('keeps polling after a dropped event stream until terminal completion', async () => {
    vi.useFakeTimers()
    const events = { addEventListener: vi.fn(), close: vi.fn(), onerror: null as (() => void) | null }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...queued, state: 'running', phase: 'downloadingModels' }))
      .mockRejectedValueOnce(new Error('temporary offline'))
      .mockResolvedValueOnce(json({ ...queued, state: 'completed', phase: 'completed' }))
    const update = vi.fn()
    const subscription = subscribeSubtitleJob('job', update, { fetcher, eventSourceFactory: () => events })
    events.onerror?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ job: expect.objectContaining({ phase: 'downloadingModels' }) }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ job: expect.objectContaining({ state: 'completed' }) }))
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    subscription.close()
  })

  it('closing during polling prevents late callbacks and further requests', async () => {
    vi.useFakeTimers()
    let resolve!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((done) => { resolve = done }))
    const events = { addEventListener: vi.fn(), close: vi.fn(), onerror: null as (() => void) | null }
    const update = vi.fn()
    const subscription = subscribeSubtitleJob('job', update, { fetcher, eventSourceFactory: () => events })
    events.onerror?.()
    subscription.close()
    resolve(json(queued))
    await vi.advanceTimersByTimeAsync(5000)
    expect(update).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('a missing job after a backend restart is actionable rather than endless polling', async () => {
    vi.useFakeTimers()
    const events = { addEventListener: vi.fn(), close: vi.fn(), onerror: null as (() => void) | null }
    const fatal = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
    subscribeSubtitleJob('job', vi.fn(), { fetcher, eventSourceFactory: () => events, onFatalError: fatal })
    events.onerror?.()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining('retry'))
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('all phases including model setup have a label in every supported locale', () => {
    for (const locale of supportedLocales) {
      for (const phase of subtitleJobPhases) expect(getMessages(locale).jobPhases[phase]).toBeTruthy()
    }
  })
})
