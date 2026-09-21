import { describe, expect, it } from 'vitest'
import { buildSubtitleSession, type SubtitleAsset } from '../subtitle-session'
import {
  createSubtitleEditorSessionInitialState,
  reduceSubtitleEditorSession,
} from './useSubtitleEditorSession'

function subtitleAsset(id: string, cueEndMs: number): SubtitleAsset {
  return {
    id,
    label: id.toUpperCase(),
    kind: 'text',
    mediaType: 'text',
    durationMs: cueEndMs,
    color: '#2fbf71',
    data: {
      mediaType: 'text',
      cues: [{ id: `${id}-cue`, startMs: 0, endMs: cueEndMs, text: id }],
    },
  }
}

describe('subtitle editor session controller', () => {
  it('replaces a loaded session and resets transient editor state in one transition', () => {
    const initial = createSubtitleEditorSessionInitialState()
    const edited = {
      ...initial,
      viewport: { pixelsPerSecond: 240 },
      clipboard: {} as typeof initial.clipboard,
      transportState: { status: 'playing' as const, playbackRate: 1.5, loop: true },
    }
    const previousHistory = edited.history
    const session = buildSubtitleSession(90_000, [subtitleAsset('en', 12_000)])

    const next = reduceSubtitleEditorSession(edited, { type: 'replace-session', session })

    expect(next.document).toBe(session.document)
    expect(next.selection).toBe(session.selection)
    expect(next.assets).toBe(session.assets)
    expect(next.viewport).toEqual({ pixelsPerSecond: 80 })
    expect(next.clipboard).toBeUndefined()
    expect(next.history).not.toBe(previousHistory)
    expect(next.transportState).toEqual({ status: 'paused', playbackRate: 1, loop: false })
  })

  it('merges generated tracks without resetting viewport, history, clipboard, or transport', () => {
    const initial = createSubtitleEditorSessionInitialState()
    const active = {
      ...initial,
      viewport: { pixelsPerSecond: 160 },
      clipboard: {} as typeof initial.clipboard,
      transportState: { status: 'playing' as const, playbackRate: 1, loop: false },
    }
    const session = buildSubtitleSession(90_000, [
      subtitleAsset('en', 12_000),
      subtitleAsset('de', 13_000),
    ])

    const next = reduceSubtitleEditorSession(active, { type: 'merge-session', session })

    expect(next.document).toBe(session.document)
    expect(next.selection).toBe(session.selection)
    expect(next.assets).toBe(session.assets)
    expect(next.viewport).toBe(active.viewport)
    expect(next.clipboard).toBe(active.clipboard)
    expect(next.history).toBe(active.history)
    expect(next.transportState).toBe(active.transportState)
  })

  it('attaches a late reference waveform without replacing live subtitle state', () => {
    const session = buildSubtitleSession(90_000, [subtitleAsset('en', 12_000)])
    const state = reduceSubtitleEditorSession(createSubtitleEditorSessionInitialState(), {
      type: 'replace-session',
      session,
    })
    const subtitleTrack = state.document.tracks[0]

    const next = reduceSubtitleEditorSession(state, {
      type: 'attach-reference-audio',
      referenceVideoDurationMs: 90_000,
      referenceAudio: {
        label: 'movie.webm',
        waveform: [0, 1, 0.5],
        channels: 1,
        sampleRate: 48_000,
      },
    })

    expect(next.document.tracks[0]?.id).toBe('reference-audio')
    expect(next.document.tracks[1]).toBe(subtitleTrack)
    expect(next.selection).toBe(state.selection)
    expect(next.history).toBe(state.history)
  })
})
