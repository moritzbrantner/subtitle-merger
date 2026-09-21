import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppMessages } from '../localization'
import type { SubtitleAsset } from '../subtitle-session'
import type { LoadedVideo } from '../video-load'
import {
  startSubtitleGeneration,
  subscribeSubtitleJob,
  type StartSubtitleGenerationOptions,
  type SubtitleJobSubscription,
} from './client'
import type { GeneratedTrack, SubtitleJob, SubtitleJobUpdate } from './types'

type SubtitleGenerationDependencies = {
  startSubtitleGeneration: typeof startSubtitleGeneration
  subscribeSubtitleJob: typeof subscribeSubtitleJob
}

type SubtitleGenerationCallbacks = {
  onGeneratingChange: (isGenerating: boolean) => void
  onMessage: (message: string) => void
  onCompleted: (job: SubtitleJob) => void
}

const defaultDependencies: SubtitleGenerationDependencies = {
  startSubtitleGeneration,
  subscribeSubtitleJob,
}

export function createSubtitleGenerationController(
  dependencies: SubtitleGenerationDependencies = defaultDependencies,
) {
  let currentAttempt = 0
  let subscription: SubtitleJobSubscription | null = null

  const closeSubscription = () => {
    subscription?.close()
    subscription = null
  }

  const cancel = () => {
    currentAttempt += 1
    closeSubscription()
  }

  const generate = async (
    options: StartSubtitleGenerationOptions,
    messages: AppMessages,
    callbacks: SubtitleGenerationCallbacks,
  ) => {
    const attempt = currentAttempt + 1
    currentAttempt = attempt
    closeSubscription()
    const isCurrentAttempt = () => currentAttempt === attempt

    callbacks.onGeneratingChange(true)
    callbacks.onMessage(messages.preparingGeneration)

    const applyJob = (job: SubtitleJob) => {
      if (!isCurrentAttempt()) return

      callbacks.onMessage(
        job.state === 'failed' && job.message
          ? job.message
          : `${messages.jobPhases[job.phase]}…`,
      )

      if (
        job.state === 'completed' ||
        job.state === 'cancelled' ||
        job.state === 'failed'
      ) {
        closeSubscription()
      }

      if (job.state === 'completed') {
        callbacks.onCompleted(job)
      }
    }

    const applyUpdate = (update: SubtitleJobUpdate) => {
      if (!isCurrentAttempt()) return

      if (update.kind === 'progress') {
        callbacks.onMessage(`${messages.jobPhases[update.progress.phase]}…`)
        return
      }

      applyJob(update.job)
    }

    try {
      const job = await dependencies.startSubtitleGeneration(options)
      if (!isCurrentAttempt()) return

      callbacks.onMessage(messages.jobPhases[job.phase])
      const nextSubscription = dependencies.subscribeSubtitleJob(job.jobId, applyUpdate, {
        onProtocolError: () => {
          if (isCurrentAttempt()) {
            callbacks.onMessage(messages.generationRunning)
          }
        },
      })

      if (!isCurrentAttempt()) {
        nextSubscription.close()
        return
      }

      subscription = nextSubscription
    } catch (error) {
      if (isCurrentAttempt()) {
        callbacks.onMessage(
          error instanceof Error ? error.message : messages.jobPhases.failed,
        )
      }
    } finally {
      if (isCurrentAttempt()) {
        callbacks.onGeneratingChange(false)
      }
    }
  }

  return {
    generate,
    cancel,
    dispose: cancel,
  }
}

export function buildGeneratedSubtitleAssets(
  job: SubtitleJob,
  referenceVideoDurationMs: number,
  messages: AppMessages,
  idFactory: () => string = () => crypto.randomUUID(),
): SubtitleAsset[] {
  const tracks = [
    job.sourceTrack
      ? { track: job.sourceTrack, label: messages.sourceTrack, color: '#2fbf71' }
      : undefined,
    job.translationTrack
      ? { track: job.translationTrack, label: messages.translationTrack, color: '#c084fc' }
      : undefined,
  ].filter(
    (entry): entry is { track: GeneratedTrack; label: string; color: string } =>
      Boolean(entry),
  )

  return tracks.map(({ track, label, color }) => ({
    id: `${label.toLowerCase()}-${idFactory()}`,
    label: `${label} — ${track.language.toUpperCase()}`,
    kind: 'text',
    mediaType: 'text',
    color,
    durationMs: Math.max(
      referenceVideoDurationMs,
      ...track.cues.map((cue) => cue.endMs),
    ),
    data: {
      mediaType: 'text' as const,
      format: 'webvtt' as const,
      language: track.language,
      cues: track.cues,
    },
  }))
}

type UseSubtitleGenerationOptions = {
  messages: AppMessages
  video?: LoadedVideo
  referenceVideoDurationMs?: number
  onCompletedAssets: (assets: SubtitleAsset[]) => void
}

type GenerationStatus = {
  videoId?: string
  isGenerating: boolean
  message?: string
}

export function useSubtitleGeneration({
  messages,
  video,
  referenceVideoDurationMs,
  onCompletedAssets,
}: UseSubtitleGenerationOptions) {
  const controller = useMemo(() => createSubtitleGenerationController(), [])
  const previousVideoIdRef = useRef(video?.id)
  const [targetLanguage, setTargetLanguage] = useState('')
  const [diarize, setDiarize] = useState(false)
  const [status, setStatus] = useState<GenerationStatus>({
    videoId: video?.id,
    isGenerating: false,
  })

  useEffect(() => () => controller.dispose(), [controller])

  useEffect(() => {
    if (previousVideoIdRef.current === video?.id) {
      return
    }

    previousVideoIdRef.current = video?.id
    controller.cancel()
    setStatus({ videoId: video?.id, isGenerating: false })
  }, [controller, video?.id])

  const generate = useCallback(async () => {
    if (!video || referenceVideoDurationMs === undefined) {
      return
    }

    const videoId = video.id
    await controller.generate(
      {
        video,
        targetLanguage: targetLanguage || undefined,
        diarize,
      },
      messages,
      {
        onGeneratingChange: (isGenerating) => {
          setStatus((current) => ({
            ...current,
            videoId,
            isGenerating,
          }))
        },
        onMessage: (message) => {
          setStatus((current) => ({
            ...current,
            videoId,
            message,
          }))
        },
        onCompleted: (job) => {
          const assets = buildGeneratedSubtitleAssets(
            job,
            referenceVideoDurationMs,
            messages,
          )

          if (assets.length > 0) {
            onCompletedAssets(assets)
          }
        },
      },
    )
  }, [
    controller,
    diarize,
    messages,
    onCompletedAssets,
    referenceVideoDurationMs,
    targetLanguage,
    video,
  ])

  const isCurrentVideo = status.videoId === video?.id

  return {
    targetLanguage,
    diarize,
    isGenerating: isCurrentVideo ? status.isGenerating : false,
    generationMessage: isCurrentVideo ? status.message : undefined,
    setTargetLanguage,
    setDiarize,
    generate,
  }
}
