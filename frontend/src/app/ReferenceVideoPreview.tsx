import { useEffect, useRef } from 'react'
import type { TimelineWorkbenchTransportState } from '@moritzbrantner/timeline-editor'
import type { AppMessages } from '../localization'
import type { ReferenceVideo } from './reference-video'

type ReferenceVideoPreviewProps = {
  referenceVideo?: ReferenceVideo
  currentTimeMs: number
  transportState: TimelineWorkbenchTransportState
  messages: AppMessages
  onCurrentTimeChange?: (timeMs: number) => void
  onError: (message: string) => void
}

const followerSeekThresholdMs = 400
const pausedSeekThresholdMs = 40
const startupSeekThresholdMs = 80

export function ReferenceVideoPreview({
  referenceVideo,
  currentTimeMs,
  transportState,
  messages,
  onError,
}: ReferenceVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackStartedRef = useRef(false)
  const previousTimelineTimeRef = useRef(currentTimeMs)
  const previousTransportRef = useRef(transportState)

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

  if (!referenceVideo) return null

  return (
    <section className="reference-preview" aria-labelledby="reference-preview-heading">
      <div className="reference-preview-heading">
        <p className="eyebrow">{messages.referenceVideo}</p>
        <h2 id="reference-preview-heading">{referenceVideo.filename}</h2>
      </div>
      <video
        ref={videoRef}
        className="reference-video"
        data-testid="reference-video"
        src={referenceVideo.mediaUrl}
        preload="metadata"
        onError={() => onError(messages.referenceVideoFailed)}
      />
    </section>
  )
}
