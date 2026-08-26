import { useEffect, useRef } from 'react'
import type { TimelineWorkbenchTransportState } from '@moritzbrantner/timeline-editor'
import type { AppMessages } from '../localization'

export type ReferenceVideo = {
  filename: string
  mediaUrl: string
  durationMs: number
}

export async function probeReferenceVideoMetadata(
  mediaUrl: string,
  messages: AppMessages,
): Promise<{ durationMs: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')

    const cleanup = () => {
      video.removeAttribute('src')
      video.load()
    }

    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const durationMs = Math.round(video.duration * 1_000)
      cleanup()

      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        reject(new Error(messages.videoDurationFailed))
        return
      }

      resolve({ durationMs })
    }
    video.onerror = () => {
      cleanup()
      reject(new Error(messages.videoLoadFailed))
    }
    video.src = mediaUrl
  })
}

type ReferenceVideoPreviewProps = {
  referenceVideo?: ReferenceVideo
  currentTimeMs: number
  transportState: TimelineWorkbenchTransportState
  messages: AppMessages
  onCurrentTimeChange: (timeMs: number) => void
  onError: (message: string) => void
}

export function ReferenceVideoPreview({
  referenceVideo,
  currentTimeMs,
  transportState,
  messages,
  onCurrentTimeChange,
  onError,
}: ReferenceVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current

    if (!video || !referenceVideo) return

    const nextTimeSeconds = Math.min(
      Math.max(currentTimeMs / 1_000, 0),
      referenceVideo.durationMs / 1_000,
    )

    if (Math.abs(video.currentTime - nextTimeSeconds) > 0.12) {
      video.currentTime = nextTimeSeconds
    }

    video.playbackRate = transportState.playbackRate > 0 ? transportState.playbackRate : 1

    if (transportState.status === 'playing' && transportState.playbackRate > 0) {
      void video.play().catch(() => onError(messages.playbackBlocked))
    } else {
      video.pause()
    }
  }, [currentTimeMs, messages, onError, referenceVideo, transportState])

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
        onTimeUpdate={(event) => {
          const nextTimeMs = Math.round(event.currentTarget.currentTime * 1_000)
          if (Math.abs(nextTimeMs - currentTimeMs) > 120) onCurrentTimeChange(nextTimeMs)
        }}
        onError={() => onError(messages.referenceVideoFailed)}
      />
    </section>
  )
}
