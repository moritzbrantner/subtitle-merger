import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppMessages } from '../localization'
import type { SubtitleAsset } from '../subtitle-session'
import type { LoadedVideo } from '../video-load'
import {
  cancelSubtitleJob,
  isTerminalJob,
  startSubtitleGeneration,
  subscribeSubtitleJob,
  type StartSubtitleGenerationOptions,
  type SubtitleJobSubscription,
} from './client'
import type { GeneratedTrack, SubtitleJob, SubtitleJobUpdate } from './types'

type SubtitleGenerationDependencies = {
  startSubtitleGeneration: typeof startSubtitleGeneration
  subscribeSubtitleJob: typeof subscribeSubtitleJob
  cancelSubtitleJob?: typeof cancelSubtitleJob
}

type SubtitleGenerationCallbacks = {
  onGeneratingChange: (isGenerating: boolean) => void
  onMessage: (message: string) => void
  onCompleted: (job: SubtitleJob) => void
}

const defaultDependencies: SubtitleGenerationDependencies = {
  startSubtitleGeneration,
  subscribeSubtitleJob,
  cancelSubtitleJob,
}

export function createSubtitleGenerationController(
  dependencies: SubtitleGenerationDependencies = defaultDependencies,
) {
  let currentAttempt = 0
  let subscription: SubtitleJobSubscription | null = null
  let startup: AbortController | null = null
  let activeJob: SubtitleJob | null = null
  let activeCallbacks: SubtitleGenerationCallbacks | null = null

  const closeSubscription = () => {
    subscription?.close()
    subscription = null
  }
  const cancelServerJob = (job: SubtitleJob) => {
    if (!isTerminalJob(job)) {
      void dependencies.cancelSubtitleJob?.(job.jobId).catch(() => undefined)
    }
  }
  const cancel = () => {
    currentAttempt += 1
    startup?.abort()
    startup = null
    closeSubscription()
    if (activeJob) cancelServerJob(activeJob)
    activeJob = null
    activeCallbacks?.onGeneratingChange(false)
    activeCallbacks = null
  }

  const generate = async (
    options: StartSubtitleGenerationOptions,
    messages: AppMessages,
    callbacks: SubtitleGenerationCallbacks,
  ) => {
    cancel()
    const attempt = currentAttempt
    const isCurrentAttempt = () => currentAttempt === attempt
    const abort = new AbortController()
    startup = abort
    activeCallbacks = callbacks
    let finished = false

    callbacks.onGeneratingChange(true)
    callbacks.onMessage(messages.preparingGeneration)

    const applyJob = (job: SubtitleJob) => {
      if (!isCurrentAttempt() || finished) return
      activeJob = job
      callbacks.onMessage(
        isTerminalJob(job) && job.message
          ? job.message
          : `${messages.jobPhases[job.phase]}…`,
      )
      if (isTerminalJob(job)) {
        finished = true
        activeJob = null
        activeCallbacks = null
        closeSubscription()
        callbacks.onGeneratingChange(false)
        if (job.sourceTrack || job.translationTrack) callbacks.onCompleted(job)
      }
    }
    const applyUpdate = (update: SubtitleJobUpdate) => {
      if (!isCurrentAttempt() || finished) return
      if (update.kind === 'progress') {
        callbacks.onMessage(`${messages.jobPhases[update.progress.phase]}…`)
      } else {
        applyJob(update.job)
      }
    }

    try {
      const job = await dependencies.startSubtitleGeneration({ ...options, signal: abort.signal })
      if (!isCurrentAttempt()) {
        cancelServerJob(job)
        return
      }
      startup = null
      applyJob(job)
      if (finished) return

      const nextSubscription = dependencies.subscribeSubtitleJob(job.jobId, applyUpdate, {
        onProtocolError: () => {
          if (isCurrentAttempt() && !finished) callbacks.onMessage(messages.generationRunning)
        },
        onFatalError: (message) => {
          if (!isCurrentAttempt() || finished) return
          finished = true
          activeJob = null
          activeCallbacks = null
          closeSubscription()
          callbacks.onGeneratingChange(false)
          callbacks.onMessage(message)
        },
      })
      // A source may synchronously replay a terminal snapshot while subscribing.
      if (!isCurrentAttempt() || finished) nextSubscription.close()
      else subscription = nextSubscription
    } catch (error) {
      if (isCurrentAttempt()) {
        startup = null
        if (activeJob) cancelServerJob(activeJob)
        activeJob = null
        activeCallbacks = null
        finished = true
        closeSubscription()
        callbacks.onGeneratingChange(false)
        callbacks.onMessage(error instanceof Error ? error.message : messages.jobPhases.failed)
      }
    }
    // Busy remains true throughout model setup and inference, not merely the POST.
  }

  return { generate, cancel, dispose: cancel }
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
    (entry): entry is { track: GeneratedTrack; label: string; color: string } => Boolean(entry),
  )

  return tracks.map(({ track, label, color }) => ({
    id: `${label.toLowerCase()}-${idFactory()}`,
    label: `${label} — ${track.language.toUpperCase()}`,
    kind: 'text',
    mediaType: 'text',
    color,
    durationMs: Math.max(referenceVideoDurationMs, ...track.cues.map((cue) => cue.endMs)),
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
  messages, video, referenceVideoDurationMs, onCompletedAssets,
}: UseSubtitleGenerationOptions) {
  const controller = useMemo(() => createSubtitleGenerationController(), [])
  const previousVideoIdRef = useRef(video?.id)
  const [sourceLanguage, setSourceLanguage] = useState('')
  const [targetLanguage, setTargetLanguage] = useState('')
  const [diarize, setDiarize] = useState(false)
  const [status, setStatus] = useState<GenerationStatus>({ videoId: video?.id, isGenerating: false })

  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => {
    if (previousVideoIdRef.current === video?.id) return
    previousVideoIdRef.current = video?.id
    controller.cancel()
    setStatus({ videoId: video?.id, isGenerating: false })
  }, [controller, video?.id])

  const generate = useCallback(async () => {
    if (!video || referenceVideoDurationMs === undefined) return
    const videoId = video.id
    await controller.generate(
      {
        video,
        sourceLanguage: sourceLanguage || undefined,
        targetLanguage: targetLanguage || undefined,
        diarize,
      },
      messages,
      {
        onGeneratingChange: (isGenerating) => {
          setStatus((current) => ({ ...current, videoId, isGenerating }))
        },
        onMessage: (message) => {
          setStatus((current) => ({ ...current, videoId, message }))
        },
        onCompleted: (job) => {
          const assets = buildGeneratedSubtitleAssets(job, referenceVideoDurationMs, messages)
          if (assets.length > 0) onCompletedAssets(assets)
        },
      },
    )
  }, [
    controller,
    diarize,
    messages,
    onCompletedAssets,
    referenceVideoDurationMs,
    sourceLanguage,
    targetLanguage,
    video,
  ])

  const updateSourceLanguage = useCallback((language: string) => {
    setSourceLanguage(language)
    if (!language) setTargetLanguage('')
  }, [])

  const isCurrentVideo = status.videoId === video?.id
  return {
    sourceLanguage, targetLanguage, diarize,
    isGenerating: isCurrentVideo ? status.isGenerating : false,
    generationMessage: isCurrentVideo ? status.message : undefined,
    setSourceLanguage: updateSourceLanguage, setTargetLanguage, setDiarize, generate,
  }
}
