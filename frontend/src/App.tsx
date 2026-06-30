import { useEffect, useMemo, useRef, useState } from 'react'
import {
  TimelineWorkbench,
  createTimelineEditorHistory,
  createTimelineMediaSourceLibrary,
  type TimelineEditorClipboard,
  type TimelineEditorDocument,
  type TimelineEditorExtension,
  type TimelineEditorHistory,
  type TimelineEditorSelection,
  type TimelineEditorViewport,
  type TimelineMediaSourceCleanup,
  type TimelineMediaSourceLibrary,
  type TimelineWorkbenchAsset,
  type TimelineWorkbenchImportResult,
  type TimelineWorkbenchImportSource,
} from '@moritzbrantner/timeline-editor'
import {
  createTimelineTextExtension,
  parseTimelineText,
  type TimelineTextFormat,
  type TimelineTextItemData,
} from '@moritzbrantner/timeline-editor/text'
import {
  createTimelineVideoExtension,
  createTimelineVideoFileAsset,
  type TimelineVideoItemData,
} from '@moritzbrantner/timeline-editor/video'
import './App.css'

type EditorItemData = TimelineVideoItemData | TimelineTextItemData
type EditorDocument = TimelineEditorDocument<Record<string, unknown>, EditorItemData>
type EditorAsset = TimelineWorkbenchAsset<EditorItemData>
type EditorHistory = TimelineEditorHistory<Record<string, unknown>, EditorItemData>
type EditorExtension = TimelineEditorExtension<EditorItemData>

type VideoLoadResponse = {
  loadId: string
  video: LoadedVideo
  subtitles: LoadedSubtitle[]
  warnings: LoadWarning[]
}

type LoadedVideo = {
  id: string
  filename: string
  stem: string
  mediaUrl: string
  mimeType: string
}

type LoadedSubtitle = {
  id: string
  filename: string
  infixTitle: string
  mediaUrl: string
  textUrl: string
  format: string
  mimeType: string
}

type LoadWarning = {
  filename: string
  message: string
}

type VideoMetadata = {
  durationMs: number
  width?: number
  height?: number
}

const videoTrackId = 'primary-video'
const defaultDocumentDurationMs = 30_000

function createEditorHistory(): EditorHistory {
  return createTimelineEditorHistory() as EditorHistory
}

function createEmptyDocument(): EditorDocument {
  return {
    durationMs: defaultDocumentDurationMs,
    currentTimeMs: 0,
    tracks: [
      {
        id: videoTrackId,
        label: 'Video',
        kind: 'video',
        acceptsItemKinds: ['video'],
        height: 124,
        items: [],
      },
    ],
  }
}

function createDocumentForVideoAsset(asset: EditorAsset): EditorDocument {
  const itemId = `${asset.id}-clip`

  return {
    durationMs: Math.max(asset.durationMs, 1_000),
    currentTimeMs: 0,
    tracks: [
      {
        id: videoTrackId,
        label: 'Video',
        kind: 'video',
        acceptsItemKinds: ['video'],
        height: 124,
        items: [
          {
            id: itemId,
            trackId: videoTrackId,
            label: asset.label,
            startMs: 0,
            durationMs: asset.durationMs,
            kind: asset.kind,
            color: asset.color,
            data: asset.data,
          },
        ],
      },
    ],
  }
}

function createDocumentForBackendLoad(
  videoAsset: EditorAsset,
  subtitleAssets: EditorAsset[],
): EditorDocument {
  const subtitleDurations = subtitleAssets.map((asset) => asset.durationMs)
  const durationMs = Math.max(videoAsset.durationMs, ...subtitleDurations, 1_000)
  const videoItemId = `${videoAsset.id}-clip`

  return {
    durationMs,
    currentTimeMs: 0,
    tracks: [
      {
        id: videoTrackId,
        label: 'Video',
        kind: 'video',
        acceptsItemKinds: ['video'],
        height: 124,
        items: [
          {
            id: videoItemId,
            trackId: videoTrackId,
            label: videoAsset.label,
            startMs: 0,
            durationMs: videoAsset.durationMs,
            kind: videoAsset.kind,
            color: videoAsset.color,
            data: videoAsset.data,
          },
        ],
      },
      ...subtitleAssets.map((asset) => {
        const trackId = `subtitle-${asset.id}`

        return {
          id: trackId,
          label: asset.label,
          kind: 'text',
          acceptsItemKinds: ['text', 'subtitle', 'caption'],
          height: 72,
          items: [
            {
              id: `${asset.id}-item`,
              trackId,
              label: asset.label,
              startMs: 0,
              durationMs: asset.durationMs,
              kind: asset.kind,
              color: asset.color,
              data: asset.data,
            },
          ],
        }
      }),
    ],
  }
}

function disposeCleanups(cleanups: TimelineMediaSourceCleanup[]) {
  for (const cleanup of cleanups) {
    cleanup()
  }
}

function getLastCueEndMs(data: TimelineTextItemData): number {
  return Math.max(0, ...(data.cues ?? []).map((cue) => cue.endMs))
}

function toTimelineTextFormat(format: string): TimelineTextFormat | undefined {
  switch (format) {
    case 'ass':
    case 'ssa':
    case 'srt':
    case 'webvtt':
      return format
    default:
      return undefined
  }
}

async function readApiError(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: unknown }

    if (typeof json.error === 'string' && json.error.length > 0) {
      return json.error
    }
  } catch {
    return response.statusText || 'Request failed.'
  }

  return response.statusText || 'Request failed.'
}

function probeVideoMetadata(mediaUrl: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')

    function cleanup() {
      video.removeAttribute('src')
      video.load()
    }

    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const durationMs = Math.round(video.duration * 1_000)

      cleanup()

      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        reject(new Error('Could not read video duration.'))
        return
      }

      resolve({
        durationMs,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      })
    }
    video.onerror = () => {
      cleanup()
      reject(new Error('Could not load video metadata from the backend.'))
    }
    video.src = mediaUrl
  })
}

function createBackendVideoAsset(
  video: LoadedVideo,
  metadata: VideoMetadata,
  sourceLibrary: TimelineMediaSourceLibrary,
): EditorAsset {
  const source = {
    id: video.id,
    uri: video.mediaUrl,
    label: video.filename,
    mimeType: video.mimeType,
  }

  sourceLibrary.register(source)

  return {
    id: video.id,
    label: video.filename,
    kind: 'video',
    mediaType: 'video',
    durationMs: metadata.durationMs,
    color: '#4f8cff',
    data: {
      mediaType: 'video',
      source,
      width: metadata.width,
      height: metadata.height,
      fit: 'contain',
    },
  }
}

async function createBackendSubtitleAsset(
  subtitle: LoadedSubtitle,
  videoDurationMs: number,
  sourceLibrary: TimelineMediaSourceLibrary,
): Promise<{ asset?: EditorAsset; warnings: LoadWarning[] }> {
  const response = await fetch(subtitle.textUrl)

  if (!response.ok) {
    return {
      warnings: [
        {
          filename: subtitle.filename,
          message: await readApiError(response),
        },
      ],
    }
  }

  const text = await response.text()
  const warnings: LoadWarning[] = []

  try {
    const parsed = parseTimelineText(text, {
      format: toTimelineTextFormat(subtitle.format),
      sourceLabel: subtitle.filename,
      mimeType: subtitle.mimeType,
    })

    for (const warning of parsed.warnings ?? []) {
      warnings.push({
        filename: subtitle.filename,
        message: warning,
      })
    }

    if (parsed.cues.length === 0) {
      return {
        warnings: [
          ...warnings,
          {
            filename: subtitle.filename,
            message: 'subtitle file has no cues',
          },
        ],
      }
    }

    const source = {
      id: subtitle.id,
      uri: subtitle.mediaUrl,
      label: subtitle.filename,
      mimeType: subtitle.mimeType,
    }
    const data: TimelineTextItemData = {
      mediaType: 'text',
      format: parsed.format,
      text,
      cues: parsed.cues,
      styles: parsed.styles,
      source,
    }
    const durationMs = Math.max(getLastCueEndMs(data), videoDurationMs)

    sourceLibrary.register(source)

    return {
      asset: {
        id: subtitle.id,
        label: subtitle.infixTitle,
        kind: 'text',
        mediaType: 'text',
        durationMs,
        color: '#2fbf71',
        data,
      },
      warnings,
    }
  } catch (error) {
    return {
      warnings: [
        ...warnings,
        {
          filename: subtitle.filename,
          message: error instanceof Error ? error.message : 'subtitle file could not be parsed',
        },
      ],
    }
  }
}

function App() {
  const sourceLibrary = useMemo<TimelineMediaSourceLibrary>(
    () => createTimelineMediaSourceLibrary(),
    [],
  )
  const importAssets = useMemo(
    () =>
      async (
        sources: TimelineWorkbenchImportSource[],
      ): Promise<TimelineWorkbenchImportResult<EditorItemData>[]> =>
        Promise.all(
          sources.map(async (source) => {
            const file = source.file

            if (
              source.type !== 'file' ||
              !file ||
              (source.mediaType !== 'video' &&
                source.kind !== 'video' &&
                !file.type.startsWith('video/'))
            ) {
              return {
                errors: [`${source.label ?? file?.name ?? 'Source'} is not a video file.`],
              }
            }

            try {
              const result = await createTimelineVideoFileAsset(file, {
                sourceLibrary,
                label: source.label,
                durationMs: source.durationMs,
                thumbnailCount: 8,
                fit: 'contain',
              })

              return {
                asset: result.asset,
                cleanup: result.cleanup,
              }
            } catch (error) {
              return {
                errors: [
                  error instanceof Error ? error.message : `Could not import ${file.name}.`,
                ],
              }
            }
          }),
        ),
    [sourceLibrary],
  )
  const videoExtension = useMemo(
    () => createTimelineVideoExtension() as unknown as EditorExtension,
    [],
  )
  const textExtension = useMemo(
    () => createTimelineTextExtension() as unknown as EditorExtension,
    [],
  )

  const [document, setDocument] = useState<EditorDocument>(() => createEmptyDocument())
  const [selection, setSelection] = useState<TimelineEditorSelection>({
    itemIds: [],
    trackIds: [videoTrackId],
  })
  const [viewport, setViewport] = useState<TimelineEditorViewport>({
    pixelsPerSecond: 80,
  })
  const [clipboard, setClipboard] = useState<TimelineEditorClipboard<EditorItemData>>()
  const [history, setHistory] = useState<EditorHistory>(() => createEditorHistory())
  const [assets, setAssets] = useState<EditorAsset[]>([])
  const [videoPath, setVideoPath] = useState('')
  const [isPathLoading, setIsPathLoading] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [loadWarnings, setLoadWarnings] = useState<LoadWarning[]>([])
  const loadedVideoCleanupsRef = useRef<TimelineMediaSourceCleanup[]>([])

  useEffect(() => {
    return () => {
      disposeCleanups(loadedVideoCleanupsRef.current)
      loadedVideoCleanupsRef.current = []
      sourceLibrary.dispose()
    }
  }, [sourceLibrary])

  function resetLoadedSources() {
    disposeCleanups(loadedVideoCleanupsRef.current)
    loadedVideoCleanupsRef.current = []
    sourceLibrary.dispose()
  }

  function commitLoadedDocument(nextAssets: EditorAsset[], nextDocument: EditorDocument) {
    const loadedItem = nextDocument.tracks[0]?.items[0]

    setAssets(nextAssets)
    setDocument(nextDocument)
    setSelection({
      itemIds: loadedItem ? [loadedItem.id] : [],
      anchorItemId: loadedItem?.id,
      trackIds: [videoTrackId],
    })
    setViewport({ pixelsPerSecond: 80 })
    setHistory(createEditorHistory())
    setClipboard(undefined)
  }

  async function loadVideo(file: File) {
    setLoadError(undefined)
    setLoadWarnings([])
    resetLoadedSources()

    try {
      const result = await createTimelineVideoFileAsset(file, {
        sourceLibrary,
        thumbnailCount: 12,
        fit: 'contain',
      })

      loadedVideoCleanupsRef.current = result.cleanup ? [result.cleanup] : []
      commitLoadedDocument([result.asset], createDocumentForVideoAsset(result.asset))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load this video.')
    }
  }

  async function loadVideoPath(path: string) {
    const trimmedPath = path.trim()

    if (!trimmedPath) {
      setLoadError('Enter an absolute video path.')
      setLoadWarnings([])
      return
    }

    setIsPathLoading(true)
    setLoadError(undefined)
    setLoadWarnings([])
    resetLoadedSources()

    try {
      const response = await fetch('/api/video-loads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: trimmedPath }),
      })

      if (!response.ok) {
        throw new Error(await readApiError(response))
      }

      const load = (await response.json()) as VideoLoadResponse
      const metadata = await probeVideoMetadata(load.video.mediaUrl)
      const videoAsset = createBackendVideoAsset(load.video, metadata, sourceLibrary)
      const subtitleResults = await Promise.all(
        load.subtitles.map((subtitle) =>
          createBackendSubtitleAsset(subtitle, metadata.durationMs, sourceLibrary),
        ),
      )
      const subtitleAssets = subtitleResults.flatMap((result) =>
        result.asset ? [result.asset] : [],
      )
      const subtitleWarnings = subtitleResults.flatMap((result) => result.warnings)
      const nextDocument = createDocumentForBackendLoad(videoAsset, subtitleAssets)

      commitLoadedDocument([videoAsset, ...subtitleAssets], nextDocument)
      setLoadWarnings([...load.warnings, ...subtitleWarnings])
    } catch (error) {
      resetLoadedSources()
      setLoadError(error instanceof Error ? error.message : 'Could not load this video path.')
    } finally {
      setIsPathLoading(false)
    }
  }

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-title">
          <p className="eyebrow">Subtitle Merger</p>
          <h1>Timeline Editor</h1>
        </div>

        <form
          className="path-loader"
          onSubmit={(event) => {
            event.preventDefault()
            void loadVideoPath(videoPath)
          }}
        >
          <input
            aria-label="Absolute video path"
            type="text"
            value={videoPath}
            placeholder="/absolute/path/to/movie.mp4"
            spellCheck={false}
            onChange={(event) => {
              setVideoPath(event.currentTarget.value)
            }}
          />
          <button type="submit" disabled={isPathLoading}>
            {isPathLoading ? 'Loading...' : 'Load video'}
          </button>
        </form>

        <label className="video-loader">
          <input
            type="file"
            accept="video/*"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''

              if (file) {
                void loadVideo(file)
              }
            }}
          />
          Load local file
        </label>
      </header>

      {loadError ? (
        <div className="load-error" role="alert">
          {loadError}
        </div>
      ) : null}

      {loadWarnings.length > 0 ? (
        <div className="load-warning" role="status">
          <ul>
            {loadWarnings.map((warning) => (
              <li key={`${warning.filename}-${warning.message}`}>
                <strong>{warning.filename}</strong>: {warning.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="editor-workbench" aria-label="Video timeline editor">
        <TimelineWorkbench
          document={document}
          selection={selection}
          viewport={viewport}
          clipboard={clipboard}
          history={history}
          assets={assets}
          extensions={[videoExtension, textExtension]}
          acceptedImportTypes={['video/*']}
          onImportAssets={importAssets}
          onDocumentChange={setDocument}
          onSelectionChange={setSelection}
          onViewportChange={setViewport}
          onClipboardChange={setClipboard}
          onHistoryChange={setHistory}
        />
      </section>
    </main>
  )
}

export default App
