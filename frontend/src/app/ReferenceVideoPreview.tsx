import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from 'react'
import type {
  TimelineTextAlignment,
  TimelineTextCue,
  TimelineTextStyle,
} from '@moritzbrantner/timeline-editor/text'
import type { TimelineWorkbenchTransportState } from '@moritzbrantner/timeline-editor'
import type { AppMessages } from '../localization'
import type { SubtitleDocument } from '../subtitle-session'
import {
  getActiveSubtitlePreviewCues,
  type ActiveSubtitlePreviewCue,
} from '../subtitle-preview'
import type { ReferenceVideo } from './reference-video'

type ReferenceVideoPreviewProps = {
  referenceVideo?: ReferenceVideo
  document: SubtitleDocument
  currentTimeMs: number
  transportState: TimelineWorkbenchTransportState
  messages: AppMessages
  onCurrentTimeChange?: (timeMs: number) => void
  onError: (message: string) => void
}

const followerSeekThresholdMs = 400
const pausedSeekThresholdMs = 40
const startupSeekThresholdMs = 80

function getAlignmentPosition(alignment: TimelineTextAlignment): { x: number; y: number } {
  const x = alignment.endsWith('left')
    ? 8
    : alignment.endsWith('right')
      ? 92
      : 50
  const y = alignment.startsWith('top')
    ? 10
    : alignment.startsWith('middle')
      ? 50
      : 90

  return { x, y }
}

function getCueTextStyle(cue: TimelineTextCue, style?: TimelineTextStyle): CSSProperties {
  const outlineColor = cue.outlineColor ?? style?.outlineColor
  const shadowColor = cue.shadowColor ?? style?.shadowColor
  const shadows: string[] = []

  if (outlineColor) {
    shadows.push(
      `-1px -1px 0 ${outlineColor}`,
      `1px -1px 0 ${outlineColor}`,
      `-1px 1px 0 ${outlineColor}`,
      `1px 1px 0 ${outlineColor}`,
    )
  }
  if (shadowColor) {
    shadows.push(`2px 2px 2px ${shadowColor}`)
  }

  const fontSize = cue.fontSize ?? style?.fontSize

  return {
    backgroundColor: cue.backgroundColor ?? style?.backgroundColor,
    color: cue.color ?? style?.color,
    fontFamily: cue.fontFamily ?? style?.fontFamily,
    fontSize: fontSize ? `${fontSize}px` : undefined,
    fontStyle: cue.italic ?? style?.italic ? 'italic' : undefined,
    fontWeight: cue.bold ?? style?.bold ? 700 : undefined,
    textDecoration: cue.underline ?? style?.underline ? 'underline' : undefined,
    textShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
  }
}

function SubtitlePreviewCue({ activeCue }: { activeCue: ActiveSubtitlePreviewCue }) {
  return (
    <div
      className="subtitle-preview-cue"
      data-testid="subtitle-preview-cue"
      data-track-id={activeCue.trackId}
      style={getCueTextStyle(activeCue.cue, activeCue.style)}
    >
      {activeCue.cue.overrideText ?? activeCue.cue.text}
    </div>
  )
}

function SubtitlePreviewOverlay({
  cues,
}: {
  cues: ActiveSubtitlePreviewCue[]
}) {
  const alignedGroups = new Map<TimelineTextAlignment, ActiveSubtitlePreviewCue[]>()
  const positionedCues: ActiveSubtitlePreviewCue[] = []

  for (const activeCue of cues) {
    if (
      Number.isFinite(activeCue.cue.positionX) ||
      Number.isFinite(activeCue.cue.positionY)
    ) {
      positionedCues.push(activeCue)
      continue
    }

    const group = alignedGroups.get(activeCue.alignment) ?? []
    group.push(activeCue)
    alignedGroups.set(activeCue.alignment, group)
  }

  return (
    <div
      className="subtitle-preview-overlay"
      data-testid="subtitle-preview-overlay"
      aria-hidden="true"
    >
      {[...alignedGroups.entries()].map(([alignment, group]) => (
        <div
          key={alignment}
          className={`subtitle-preview-group subtitle-preview-${alignment}`}
        >
          {group.map((activeCue) => (
            <SubtitlePreviewCue key={activeCue.key} activeCue={activeCue} />
          ))}
        </div>
      ))}
      {positionedCues.map((activeCue) => {
        const fallback = getAlignmentPosition(activeCue.alignment)
        const x = Number.isFinite(activeCue.cue.positionX)
          ? Math.min(100, Math.max(0, activeCue.cue.positionX!))
          : fallback.x
        const y = Number.isFinite(activeCue.cue.positionY)
          ? Math.min(100, Math.max(0, activeCue.cue.positionY!))
          : fallback.y

        return (
          <div
            key={activeCue.key}
            className="subtitle-preview-group subtitle-preview-positioned"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            <SubtitlePreviewCue activeCue={activeCue} />
          </div>
        )
      })}
    </div>
  )
}

export function ReferenceVideoPreview({
  referenceVideo,
  document,
  currentTimeMs,
  transportState,
  messages,
  onError,
}: ReferenceVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackStartedRef = useRef(false)
  const previousTimelineTimeRef = useRef(currentTimeMs)
  const previousTransportRef = useRef(transportState)
  const activeSubtitleCues = useMemo(
    () => getActiveSubtitlePreviewCues(document, currentTimeMs),
    [currentTimeMs, document],
  )

  useEffect(() => {
    const video = videoRef.current

    if (!video || !referenceVideo) return

    const nextTimeSeconds = Math.min(
      Math.max(currentTimeMs / 1_000, 0),
      referenceVideo.durationMs / 1_000,
    )
    const driftMs = Math.abs(video.currentTime - nextTimeSeconds) * 1_000
    const previousTimelineTimeMs = previousTimelineTimeRef.current
    const previousTransport = previousTransportRef.current
    const timelineDeltaMs = currentTimeMs - previousTimelineTimeMs
    const rememberSnapshot = () => {
      previousTimelineTimeRef.current = currentTimeMs
      previousTransportRef.current = transportState
    }
    const seek = () => {
      if (Number.isFinite(nextTimeSeconds)) video.currentTime = nextTimeSeconds
    }

    if (transportState.status !== 'playing') {
      if (!video.paused) video.pause()
      if (driftMs > pausedSeekThresholdMs) seek()
      playbackStartedRef.current = false
      rememberSnapshot()
      return
    }

    if (transportState.playbackRate < 0) {
      if (!video.paused) video.pause()
      seek()
      playbackStartedRef.current = false
      rememberSnapshot()
      return
    }

    video.playbackRate = transportState.playbackRate
    const playbackTransition =
      !playbackStartedRef.current ||
      previousTransport.status !== 'playing' ||
      previousTransport.playbackRate !== transportState.playbackRate ||
      timelineDeltaMs < -pausedSeekThresholdMs ||
      Math.abs(timelineDeltaMs) > followerSeekThresholdMs

    if (
      driftMs > startupSeekThresholdMs &&
      (playbackTransition || driftMs > followerSeekThresholdMs)
    ) {
      seek()
    }

    if (video.paused || !playbackStartedRef.current) {
      playbackStartedRef.current = true
      void video.play().catch(() => {
        playbackStartedRef.current = false
        onError(messages.playbackBlocked)
      })
    }

    rememberSnapshot()
  }, [currentTimeMs, messages.playbackBlocked, onError, referenceVideo, transportState])

  return (
    <section className="reference-preview" aria-labelledby="reference-preview-heading">
      <div className="reference-preview-heading">
        <p className="eyebrow">{messages.referenceVideo}</p>
        <h2 id="reference-preview-heading">
          {referenceVideo?.filename ?? messages.openVideo}
        </h2>
      </div>
      <div className="reference-video-stage" data-testid="reference-video-stage">
        {referenceVideo ? (
          <>
            <video
              ref={videoRef}
              className="reference-video"
              data-testid="reference-video"
              src={referenceVideo.mediaUrl}
              preload="metadata"
              playsInline
              onError={() => onError(messages.referenceVideoFailed)}
            />
            {activeSubtitleCues.length > 0 ? (
              <SubtitlePreviewOverlay cues={activeSubtitleCues} />
            ) : null}
          </>
        ) : (
          <div className="reference-video-empty">
            <span>{messages.openVideo}</span>
          </div>
        )}
      </div>
    </section>
  )
}
