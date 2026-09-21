import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppMessages } from '../localization'
import {
  loadReferenceVideoAudio,
  type ReferenceVideoAudio,
} from '../reference-video-audio'
import type { SubtitleAsset } from '../subtitle-session'
import {
  loadSubtitleAssets,
  requestVideoLoad,
  type LoadedVideo,
  type LoadWarning,
  type VideoLoadResponse,
} from '../video-load'
import {
  probeReferenceVideoMetadata,
  type ReferenceVideo,
} from './reference-video'

type ReferenceVideoLoadDependencies = {
  requestVideoLoad: typeof requestVideoLoad
  probeReferenceVideoMetadata: typeof probeReferenceVideoMetadata
  loadSubtitleAssets: typeof loadSubtitleAssets
  loadReferenceVideoAudio: typeof loadReferenceVideoAudio
}

type LoadedReferenceVideoSession = {
  referenceVideo: ReferenceVideo
  selectedVideo: LoadedVideo
  assets: SubtitleAsset[]
  warnings: LoadWarning[]
}

type ReferenceVideoLoadCallbacks = {
  onStarted: () => void
  onSessionLoaded: (session: LoadedReferenceVideoSession) => void
  onReferenceAudioLoaded: (
    referenceVideoDurationMs: number,
    referenceAudio: ReferenceVideoAudio,
  ) => void
  onReferenceAudioWarning: (warning: LoadWarning) => void
  onFailed: (error: Error) => void
  onFinished: () => void
}

const defaultDependencies: ReferenceVideoLoadDependencies = {
  requestVideoLoad,
  probeReferenceVideoMetadata,
  loadSubtitleAssets,
  loadReferenceVideoAudio,
}

export function createReferenceVideoLoadController(
  dependencies: ReferenceVideoLoadDependencies = defaultDependencies,
) {
  let currentAttempt = 0
  let referenceAudioAbort: AbortController | undefined

  const cancel = () => {
    currentAttempt += 1
    referenceAudioAbort?.abort()
    referenceAudioAbort = undefined
  }

  const load = async (
    path: string,
    messages: AppMessages,
    callbacks: ReferenceVideoLoadCallbacks,
  ) => {
    const attempt = currentAttempt + 1
    currentAttempt = attempt
    referenceAudioAbort?.abort()
    referenceAudioAbort = undefined
    const isCurrentAttempt = () => currentAttempt === attempt

    callbacks.onStarted()

    try {
      const videoLoad: VideoLoadResponse = await dependencies.requestVideoLoad(path)
      if (!isCurrentAttempt()) return

      const metadata = await dependencies.probeReferenceVideoMetadata(
        videoLoad.video.mediaUrl,
        messages,
      )
      if (!isCurrentAttempt()) return

      const subtitles = await dependencies.loadSubtitleAssets(
        videoLoad,
        metadata.durationMs,
      )
      if (!isCurrentAttempt()) return

      callbacks.onSessionLoaded({
        referenceVideo: {
          filename: videoLoad.video.filename,
          mediaUrl: videoLoad.video.mediaUrl,
          durationMs: metadata.durationMs,
        },
        selectedVideo: videoLoad.video,
        assets: subtitles.assets,
        warnings: subtitles.warnings,
      })

      const audioAbort = new AbortController()
      referenceAudioAbort = audioAbort
      void dependencies
        .loadReferenceVideoAudio(videoLoad.video, { signal: audioAbort.signal })
        .then((referenceAudio) => {
          if (!isCurrentAttempt()) return

          callbacks.onReferenceAudioLoaded(metadata.durationMs, referenceAudio)
        })
        .catch((error) => {
          if (!isCurrentAttempt()) return

          callbacks.onReferenceAudioWarning({
            filename: videoLoad.video.filename,
            message:
              error instanceof Error
                ? error.message
                : 'Reference video waveform is unavailable.',
          })
        })
    } catch (error) {
      if (isCurrentAttempt()) {
        callbacks.onFailed(
          error instanceof Error ? error : new Error(messages.videoLoadFailed),
        )
      }
    } finally {
      if (isCurrentAttempt()) {
        callbacks.onFinished()
      }
    }
  }

  return {
    load,
    cancel,
    dispose: cancel,
  }
}

type UseReferenceVideoLoaderOptions = {
  messages: AppMessages
  onSessionLoaded: (
    referenceVideo: ReferenceVideo,
    assets: SubtitleAsset[],
  ) => void
  onReferenceAudioLoaded: (
    referenceVideoDurationMs: number,
    referenceAudio: ReferenceVideoAudio,
  ) => void
}

export function useReferenceVideoLoader({
  messages,
  onSessionLoaded,
  onReferenceAudioLoaded,
}: UseReferenceVideoLoaderOptions) {
  const controller = useMemo(() => createReferenceVideoLoadController(), [])
  const [isVideoPathDialogOpen, setIsVideoPathDialogOpen] = useState(false)
  const [isLoadingVideo, setIsLoadingVideo] = useState(false)
  const [videoPathError, setVideoPathError] = useState<string>()
  const [selectedVideo, setSelectedVideo] = useState<LoadedVideo>()
  const [referenceVideo, setReferenceVideo] = useState<ReferenceVideo>()
  const [loadWarnings, setLoadWarnings] = useState<LoadWarning[]>([])

  useEffect(() => () => controller.dispose(), [controller])

  const openVideoDialog = useCallback(() => {
    setVideoPathError(undefined)
    setIsVideoPathDialogOpen(true)
  }, [])

  const closeVideoDialog = useCallback(() => {
    controller.cancel()
    setIsLoadingVideo(false)
    setVideoPathError(undefined)
    setIsVideoPathDialogOpen(false)
  }, [controller])

  const clearVideoPathError = useCallback(() => setVideoPathError(undefined), [])

  const loadVideo = useCallback(
    (path: string) =>
      controller.load(path, messages, {
        onStarted: () => {
          setIsLoadingVideo(true)
          setVideoPathError(undefined)
        },
        onSessionLoaded: (session) => {
          setReferenceVideo(session.referenceVideo)
          setSelectedVideo(session.selectedVideo)
          setLoadWarnings(session.warnings)
          setIsVideoPathDialogOpen(false)
          onSessionLoaded(session.referenceVideo, session.assets)
        },
        onReferenceAudioLoaded,
        onReferenceAudioWarning: (warning) => {
          setLoadWarnings((current) => [...current, warning])
        },
        onFailed: (error) => setVideoPathError(error.message),
        onFinished: () => setIsLoadingVideo(false),
      }),
    [controller, messages, onReferenceAudioLoaded, onSessionLoaded],
  )

  return {
    referenceVideo,
    selectedVideo,
    loadWarnings,
    isVideoPathDialogOpen,
    isLoadingVideo,
    videoPathError,
    openVideoDialog,
    closeVideoDialog,
    clearVideoPathError,
    loadVideo,
  }
}
