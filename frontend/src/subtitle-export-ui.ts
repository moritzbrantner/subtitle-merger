import type { SubtitleExport } from './subtitle-export'

export type EditableSubtitleTrackOption = {
  id: string
  label: string
  language?: string
}

export type SubtitleDownloadEnvironment = {
  createObjectUrl: (blob: Blob) => string
  revokeObjectUrl: (url: string) => void
  download: (url: string, filename: string) => void
}

export function resolveExportTrackId(
  tracks: EditableSubtitleTrackOption[],
  selectedTrackIds: string[] = [],
): string | undefined {
  const selected = selectedTrackIds.find((trackId) =>
    tracks.some((track) => track.id === trackId),
  )

  return selected ?? tracks[0]?.id
}

const browserDownloadEnvironment: SubtitleDownloadEnvironment = {
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  download: (url, filename) => {
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.style.display = 'none'
    window.document.body.append(anchor)
    anchor.click()
    anchor.remove()
  },
}

export function downloadSubtitleExport(
  exported: SubtitleExport,
  environment: SubtitleDownloadEnvironment = browserDownloadEnvironment,
): void {
  const blob = new Blob([exported.text], { type: exported.mimeType })
  const url = environment.createObjectUrl(blob)

  try {
    environment.download(url, exported.filename)
  } finally {
    environment.revokeObjectUrl(url)
  }
}
