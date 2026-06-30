import { useEffect, useMemo, useRef, useState } from 'react'
import {
  TimelineWorkbench,
  createTimelineEditorHistory,
  createTimelineMediaSourceLibrary,
  type TimelineEditorClipboard,
  type TimelineEditorDocument,
  type TimelineEditorHistory,
  type TimelineEditorSelection,
  type TimelineEditorViewport,
  type TimelineMediaSourceCleanup,
  type TimelineMediaSourceLibrary,
  type TimelineWorkbenchImportResult,
  type TimelineWorkbenchImportSource,
  type TimelineWorkbenchAsset,
} from '@moritzbrantner/timeline-editor'
import {
  createTimelineVideoExtension,
  createTimelineVideoFileAsset,
  type TimelineVideoItemData,
} from '@moritzbrantner/timeline-editor/video'
import './App.css'

type EditorDocument = TimelineEditorDocument<Record<string, unknown>, TimelineVideoItemData>
type EditorAsset = TimelineWorkbenchAsset<TimelineVideoItemData>
type EditorHistory = TimelineEditorHistory<Record<string, unknown>, TimelineVideoItemData>

const videoTrackId = 'primary-video'

function createEditorHistory(): EditorHistory {
  return createTimelineEditorHistory() as EditorHistory
}

function createEmptyDocument(): EditorDocument {
  return {
    durationMs: 30_000,
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

function disposeCleanups(cleanups: TimelineMediaSourceCleanup[]) {
  for (const cleanup of cleanups) {
    cleanup()
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
      ): Promise<TimelineWorkbenchImportResult<TimelineVideoItemData>[]> =>
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
  const videoExtension = useMemo(() => createTimelineVideoExtension(), [])

  const [document, setDocument] = useState<EditorDocument>(() => createEmptyDocument())
  const [selection, setSelection] = useState<TimelineEditorSelection>({
    itemIds: [],
    trackIds: [videoTrackId],
  })
  const [viewport, setViewport] = useState<TimelineEditorViewport>({
    pixelsPerSecond: 80,
  })
  const [clipboard, setClipboard] = useState<TimelineEditorClipboard<TimelineVideoItemData>>()
  const [history, setHistory] = useState<EditorHistory>(() => createEditorHistory())
  const [assets, setAssets] = useState<EditorAsset[]>([])
  const [loadError, setLoadError] = useState<string>()
  const loadedVideoCleanupsRef = useRef<TimelineMediaSourceCleanup[]>([])

  useEffect(() => {
    return () => {
      disposeCleanups(loadedVideoCleanupsRef.current)
      loadedVideoCleanupsRef.current = []
      sourceLibrary.dispose()
    }
  }, [sourceLibrary])

  async function loadVideo(file: File) {
    setLoadError(undefined)

    try {
      const result = await createTimelineVideoFileAsset(file, {
        sourceLibrary,
        thumbnailCount: 12,
        fit: 'contain',
      })

      disposeCleanups(loadedVideoCleanupsRef.current)
      loadedVideoCleanupsRef.current = result.cleanup ? [result.cleanup] : []

      const nextDocument = createDocumentForVideoAsset(result.asset)
      const loadedItem = nextDocument.tracks[0]?.items[0]

      setAssets([result.asset])
      setDocument(nextDocument)
      setSelection({
        itemIds: loadedItem ? [loadedItem.id] : [],
        anchorItemId: loadedItem?.id,
        trackIds: [videoTrackId],
      })
      setViewport({ pixelsPerSecond: 80 })
      setHistory(createEditorHistory())
      setClipboard(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load this video.')
    }
  }

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-title">
          <p className="eyebrow">Subtitle Merger</p>
          <h1>Timeline Editor</h1>
        </div>

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
          Load video
        </label>
      </header>

      {loadError ? (
        <div className="load-error" role="alert">
          {loadError}
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
          extensions={[videoExtension]}
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
