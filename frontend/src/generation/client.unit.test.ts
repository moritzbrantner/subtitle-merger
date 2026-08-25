import { describe, expect, it } from 'vitest'
import { parseSubtitleJob, parseSubtitleJobUpdate } from './client'

describe('subtitle generation protocol', () => {
  it('parses stable typed progress updates', () => {
    expect(parseSubtitleJobUpdate({ state: 'running', phase: 'diarizing' })).toEqual({
      kind: 'progress',
      progress: { state: 'running', phase: 'diarizing' },
    })
  })

  it('rejects unknown lifecycle values instead of accepting arbitrary strings', () => {
    expect(() => parseSubtitleJobUpdate({ state: 'running', phase: 'someDebugEvent' })).toThrow(
      'unknown phase',
    )
    expect(() => parseSubtitleJobUpdate({ state: 'mystery', phase: 'transcribing' })).toThrow(
      'unknown state',
    )
  })

  it('parses a completed speaker-aware job snapshot', () => {
    const job = parseSubtitleJob({
      jobId: 'job-1',
      sessionId: 'session-1',
      state: 'completed',
      phase: 'completed',
      progress: 100,
      message: 'source subtitles generated',
      sourceTrack: {
        language: 'en',
        pivoted: false,
        cues: [
          {
            startMs: 100,
            endMs: 900,
            text: 'Hello',
            actor: 'SPEAKER_00',
          },
        ],
      },
      translationTrack: null,
    })

    expect(job.state).toBe('completed')
    expect(job.sourceTrack?.cues[0]?.actor).toBe('SPEAKER_00')
    expect(job.translationTrack).toBeNull()
  })
})
