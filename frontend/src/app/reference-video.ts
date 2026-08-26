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
