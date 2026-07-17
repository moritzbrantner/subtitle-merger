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

const videoTrackId = 'primary-video'
const defaultDocumentDurationMs = 30_000
const languageOptions = [
  ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'],
] as const

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
  const [loadError, setLoadError] = useState<string>()
  const [generationMessage, setGenerationMessage] = useState<string>()
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedVideo, setSelectedVideo] = useState<File>()
  const [targetLanguage, setTargetLanguage] = useState('')
  const [diarize, setDiarize] = useState(false)
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false)
  const videoFileInputRef = useRef<HTMLInputElement>(null)
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
    resetLoadedSources()

    try {
      const result = await createTimelineVideoFileAsset(file, {
        sourceLibrary,
        thumbnailCount: 12,
        fit: 'contain',
      })

      loadedVideoCleanupsRef.current = result.cleanup ? [result.cleanup] : []
      commitLoadedDocument([result.asset], createDocumentForVideoAsset(result.asset))
      setSelectedVideo(file)
      setGenerationMessage(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load this video.')
    }
  }

  async function generateSubtitles() {
    if (!selectedVideo) return
    setIsGenerating(true)
    setGenerationMessage('Preparing subtitle generation…')
    try {
      const sessionResponse = await fetch('/api/subtitle-sessions', { method: 'POST' })
      if (!sessionResponse.ok) throw new Error('Could not create subtitle session.')
      const { sessionId } = (await sessionResponse.json()) as { sessionId: string }
      const form = new FormData()
      form.set('sessionId', sessionId)
      form.set('video', selectedVideo)
      if (targetLanguage) form.set('targetLanguage', targetLanguage)
      form.set('qualityProfile', 'balanced')
      form.set('diarize', String(diarize))
      const response = await fetch('/api/subtitle-jobs', { method: 'POST', body: form })
      const job = (await response.json()) as { message?: string }
      if (!response.ok) throw new Error(job.message ?? 'Could not start subtitle generation.')
      setGenerationMessage(job.message ?? 'Subtitle generation started.')
    } catch (error) {
      setGenerationMessage(error instanceof Error ? error.message : 'Could not start subtitle generation.')
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-title">
          <p className="eyebrow">Subtitle Merger</p>
          <h1>Timeline Editor</h1>
        </div>

        <nav className="menu-bar" aria-label="Main menu">
          <button
            className="menu-trigger"
            type="button"
            aria-expanded={isFileMenuOpen}
            aria-controls="file-menu"
            aria-haspopup="menu"
            onClick={() => {
              setIsFileMenuOpen((isOpen) => !isOpen)
            }}
          >
            File
          </button>
          {isFileMenuOpen ? (
            <div className="menu-items" id="file-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsFileMenuOpen(false)
                  videoFileInputRef.current?.click()
                }}
              >
                Open video…
              </button>
            </div>
          ) : null}
          <input
            ref={videoFileInputRef}
            className="video-file-input"
            type="file"
            accept="video/*,.mp4,.m4v,.mov,.webm,.mkv,.avi"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''

              if (file) {
                void loadVideo(file)
              }
            }}
          />
        </nav>
      </header>

      <div className="editor-content">
        {loadError ? (
          <div className="load-error" role="alert">
            {loadError}
          </div>
        ) : null}
        {selectedVideo ? (
          <section className="generation-panel" aria-labelledby="generation-heading">
            <div>
              <p className="eyebrow">Automatic subtitles</p>
              <h2 id="generation-heading">Generate subtitles</h2>
              <p>Creates an editable source track and optional translated track.</p>
            </div>
            <label>
              Translate to
              <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.currentTarget.value)}>
                <option value="">No translation</option>
                {languageOptions.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </label>
            <label className="checkbox-label"><input type="checkbox" checked={diarize} onChange={(event) => setDiarize(event.currentTarget.checked)} /> Identify speakers</label>
            <button className="generate-button" type="button" disabled={isGenerating} onClick={() => void generateSubtitles()}>
              {isGenerating ? 'Starting…' : 'Generate subtitles'}
            </button>
            {generationMessage ? <p className="generation-status" role="status">{generationMessage}</p> : null}
          </section>
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
      </div>
    </main>
  )
}

export default App
