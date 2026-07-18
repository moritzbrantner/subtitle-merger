import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  TimelineWorkbench,
  createTimelineEditorHistory,
  type TimelineEditorClipboard,
  type TimelineEditorExtension,
  type TimelineEditorHistory,
  type TimelineEditorSelection,
  type TimelineEditorViewport,
  type TimelineWorkbenchTransportState,
} from '@moritzbrantner/timeline-editor'
import {
  createTimelineTextExtension,
  type TimelineTextItemData,
} from '@moritzbrantner/timeline-editor/text'
import {
  buildSubtitleSession,
  createEmptySubtitleDocument,
  type SubtitleAsset,
  type SubtitleDocument,
} from './subtitle-session'
import {
  loadSubtitleAssets,
  readApiError,
  requestVideoPick,
  type LoadedVideo,
  type LoadWarning,
} from './video-load'
import { getFitTimelinePixelsPerSecond } from './timeline-viewport'
import './App.css'

type EditorHistory = TimelineEditorHistory<Record<string, unknown>, TimelineTextItemData>
type EditorExtension = TimelineEditorExtension<TimelineTextItemData>

type ReferenceVideo = {
  filename: string
  mediaUrl: string
  durationMs: number
}

type VideoMetadata = {
  durationMs: number
}

type GeneratedCue = { startMs: number; endMs: number; text: string }
type GeneratedTrack = { language: string; pivoted: boolean; cues: GeneratedCue[] }
type SubtitleJob = {
  jobId: string
  state: string
  phase: string
  progress: number
  message: string
  sourceTrack?: GeneratedTrack
  translationTrack?: GeneratedTrack
}

const defaultTransportState: TimelineWorkbenchTransportState = {
  status: 'paused',
  playbackRate: 1,
  loop: false,
}
const languageOptions = [
  ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'],
] as const

function createEditorHistory(): EditorHistory {
  return createTimelineEditorHistory() as EditorHistory
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

      resolve({ durationMs })
    }
    video.onerror = () => {
      cleanup()
      reject(new Error('Could not load video metadata.'))
    }
    video.src = mediaUrl
  })
}

function useTimelineViewportWidth(containerRef: RefObject<HTMLElement | null>): number {
  const [widthPx, setWidthPx] = useState(0)

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    const editor = container.querySelector<HTMLElement>("[data-slot='timeline-editor']")
    const updateWidth = () => {
      setWidthPx(editor?.clientWidth ?? 0)
    }
    const resizeObserver = new ResizeObserver(updateWidth)

    resizeObserver.observe(container)
    if (editor) {
      resizeObserver.observe(editor)
    }
    updateWidth()

    return () => resizeObserver.disconnect()
  }, [containerRef])

  return widthPx
}

function ReferenceVideoPreview({
  referenceVideo,
  currentTimeMs,
  transportState,
  onCurrentTimeChange,
  onError,
}: {
  referenceVideo?: ReferenceVideo
  currentTimeMs: number
  transportState: TimelineWorkbenchTransportState
  onCurrentTimeChange: (timeMs: number) => void
  onError: (message: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current

    if (!video || !referenceVideo) {
      return
    }

    const nextTimeSeconds = Math.min(
      Math.max(currentTimeMs / 1_000, 0),
      referenceVideo.durationMs / 1_000,
    )

    if (Math.abs(video.currentTime - nextTimeSeconds) > 0.12) {
      video.currentTime = nextTimeSeconds
    }

    video.playbackRate = transportState.playbackRate > 0 ? transportState.playbackRate : 1

    if (transportState.status === 'playing' && transportState.playbackRate > 0) {
      void video.play().catch(() => {
        onError('Video playback was blocked. Interact with the timeline and try again.')
      })
    } else {
      video.pause()
    }
  }, [currentTimeMs, onError, referenceVideo, transportState])

  if (!referenceVideo) {
    return null
  }

  return (
    <section className="reference-preview" aria-labelledby="reference-preview-heading">
      <div className="reference-preview-heading">
        <p className="eyebrow">Reference video</p>
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

          if (Math.abs(nextTimeMs - currentTimeMs) > 120) {
            onCurrentTimeChange(nextTimeMs)
          }
        }}
        onError={() => {
          onError('Could not play the reference video.')
        }}
      />
    </section>
  )
}

function App() {
  const textExtension = useMemo(
    () => createTimelineTextExtension() as unknown as EditorExtension,
    [],
  )
  const [document, setDocument] = useState<SubtitleDocument>(() => createEmptySubtitleDocument())
  const [selection, setSelection] = useState<TimelineEditorSelection>({ itemIds: [], trackIds: [] })
  const [viewport, setViewport] = useState<TimelineEditorViewport>({ pixelsPerSecond: 80 })
  const [clipboard, setClipboard] = useState<TimelineEditorClipboard<TimelineTextItemData>>()
  const [history, setHistory] = useState<EditorHistory>(() => createEditorHistory())
  const [assets, setAssets] = useState<SubtitleAsset[]>([])
  const [referenceVideo, setReferenceVideo] = useState<ReferenceVideo>()
  const [transportState, setTransportState] = useState(defaultTransportState)
  const [loadError, setLoadError] = useState<string>()
  const [emptyState, setEmptyState] = useState<string>()
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false)
  const [isPickingVideo, setIsPickingVideo] = useState(false)
  const [selectedVideo, setSelectedVideo] = useState<LoadedVideo>()
  const [loadWarnings, setLoadWarnings] = useState<LoadWarning[]>([])
  const [targetLanguage, setTargetLanguage] = useState('')
  const [diarize, setDiarize] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationMessage, setGenerationMessage] = useState<string>()
  const jobEventsRef = useRef<EventSource | null>(null)
  const editorWorkbenchRef = useRef<HTMLElement>(null)
  const editorViewportWidthPx = useTimelineViewportWidth(editorWorkbenchRef)
  const minPixelsPerSecond = useMemo(
    () => getFitTimelinePixelsPerSecond(document.durationMs ?? 0, editorViewportWidthPx),
    [document.durationMs, editorViewportWidthPx],
  )

  function commitLoadedSession(video: ReferenceVideo, nextAssets: SubtitleAsset[]) {
    const session = buildSubtitleSession(video.durationMs, nextAssets)

    setReferenceVideo(video)
    setAssets(session.assets)
    setDocument(session.document)
    setSelection(session.selection)
    setViewport({ pixelsPerSecond: 80 })
    setHistory(createEditorHistory())
    setClipboard(undefined)
    setTransportState(defaultTransportState)
    setEmptyState(
      nextAssets.length === 0
        ? 'No subtitle tracks yet. Generate subtitles to add editable tracks.'
        : undefined,
    )
  }

  async function openVideo() {
    setIsPickingVideo(true)
    setLoadError(undefined)
    setLoadWarnings([])
    setEmptyState(undefined)

    try {
      const result = await requestVideoPick()

      if (result.status === 'cancelled') {
        return
      }

      const metadata = await probeVideoMetadata(result.load.video.mediaUrl)
      const subtitles = await loadSubtitleAssets(result.load, metadata.durationMs)

      commitLoadedSession(
        {
          filename: result.load.video.filename,
          mediaUrl: result.load.video.mediaUrl,
          durationMs: metadata.durationMs,
        },
        subtitles.assets,
      )
      setSelectedVideo(result.load.video)
      setLoadWarnings(subtitles.warnings)
      setGenerationMessage(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load this video.')
    } finally {
      setIsPickingVideo(false)
    }
  }

  async function generateSubtitles() {
    if (!selectedVideo) {
      return
    }

    setIsGenerating(true)
    setGenerationMessage('Preparing subtitle generation…')

    try {
      const sessionResponse = await fetch('/api/subtitle-sessions', { method: 'POST' })

      if (!sessionResponse.ok) {
        throw new Error('Could not create subtitle session.')
      }

      const { sessionId } = (await sessionResponse.json()) as { sessionId: string }
      const videoResponse = await fetch(selectedVideo.mediaUrl)

      if (!videoResponse.ok) {
        throw new Error(await readApiError(videoResponse))
      }

      const videoBlob = await videoResponse.blob()
      const form = new FormData()
      form.set('sessionId', sessionId)
      form.set(
        'video',
        new File([videoBlob], selectedVideo.filename, {
          type: selectedVideo.mimeType || videoBlob.type,
        }),
      )
      if (targetLanguage) {
        form.set('targetLanguage', targetLanguage)
      }
      form.set('qualityProfile', 'balanced')
      form.set('diarize', String(diarize))
      const response = await fetch('/api/subtitle-jobs', { method: 'POST', body: form })
      const job = (await response.json()) as SubtitleJob

      if (!response.ok) {
        throw new Error(job.message ?? 'Could not start subtitle generation.')
      }

      setGenerationMessage(job.message ?? 'Subtitle generation started.')
      jobEventsRef.current?.close()
      const events = new EventSource(`/api/subtitle-jobs/${job.jobId}/events`)
      events.addEventListener('progress', (event) => {
        try {
          applySubtitleJob(JSON.parse((event as MessageEvent<string>).data) as SubtitleJob)
        } catch {
          setGenerationMessage('Subtitle generation is running…')
        }
      })
      events.onerror = () => {
        events.close()
        void fetch(`/api/subtitle-jobs/${job.jobId}`)
          .then((result) => result.ok ? result.json() : undefined)
          .then((snapshot) => { if (snapshot) applySubtitleJob(snapshot as SubtitleJob) })
      }
      jobEventsRef.current = events
    } catch (error) {
      setGenerationMessage(
        error instanceof Error ? error.message : 'Could not start subtitle generation.',
      )
    } finally {
      setIsGenerating(false)
    }
  }

  function applySubtitleJob(job: SubtitleJob) {
    setGenerationMessage(job.message || `${job.phase}…`)
    if (job.state !== 'completed') return
    jobEventsRef.current?.close()
    const tracks = [
      job.sourceTrack ? { track: job.sourceTrack, label: 'Subtitles', color: '#2fbf71' } : undefined,
      job.translationTrack ? { track: job.translationTrack, label: 'Translation', color: '#c084fc' } : undefined,
    ].filter((entry): entry is { track: GeneratedTrack; label: string; color: string } => Boolean(entry))
    if (!referenceVideo || tracks.length === 0) return
    const generatedAssets: SubtitleAsset[] = tracks.map(({ track, label, color }) => ({
      id: `${label.toLowerCase()}-${crypto.randomUUID()}`,
      label: `${label} — ${track.language.toUpperCase()}`,
      kind: 'text', mediaType: 'text', color,
      durationMs: Math.max(referenceVideo.durationMs, ...track.cues.map((cue) => cue.endMs)),
      data: { mediaType: 'text' as const, format: 'webvtt' as const, language: track.language, cues: track.cues },
    }))
    const session = buildSubtitleSession(referenceVideo.durationMs, [...assets, ...generatedAssets])
    setAssets(session.assets)
    setDocument(session.document)
    setSelection(session.selection)
    setEmptyState(undefined)
  }

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-title">
          <p className="eyebrow">Subtitle Merger</p>
          <h1>Subtitle Timeline Editor</h1>
        </div>

        <nav className="menu-bar" aria-label="Main menu">
          <button
            className="menu-trigger"
            type="button"
            aria-expanded={isFileMenuOpen}
            aria-controls="file-menu"
            aria-haspopup="menu"
            onClick={() => setIsFileMenuOpen((isOpen) => !isOpen)}
          >
            File
          </button>
          {isFileMenuOpen ? (
            <div className="menu-items" id="file-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={isPickingVideo}
                onClick={() => {
                  setIsFileMenuOpen(false)
                  void openVideo()
                }}
              >
                {isPickingVideo ? 'Opening…' : 'Open video…'}
              </button>
            </div>
          ) : null}
        </nav>
      </header>

      <div className="editor-content">
        {loadError ? <div className="load-error" role="alert">{loadError}</div> : null}
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
        {emptyState ? <div className="empty-state" role="status">{emptyState}</div> : null}
        {selectedVideo ? (
          <section className="generation-panel" aria-labelledby="generation-heading">
            <div>
              <p className="eyebrow">Automatic subtitles</p>
              <h2 id="generation-heading">Generate subtitles</h2>
              <p>Creates an editable source track and optional translated track.</p>
            </div>
            <label>
              Translate to
              <select
                value={targetLanguage}
                onChange={(event) => setTargetLanguage(event.currentTarget.value)}
              >
                <option value="">No translation</option>
                {languageOptions.map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={diarize}
                onChange={(event) => setDiarize(event.currentTarget.checked)}
              />
              Identify speakers
            </label>
            <button
              className="generate-button"
              type="button"
              disabled={isGenerating}
              onClick={() => void generateSubtitles()}
            >
              {isGenerating ? 'Starting…' : 'Generate subtitles'}
            </button>
            {generationMessage ? <p className="generation-status" role="status">{generationMessage}</p> : null}
          </section>
        ) : null}

        <ReferenceVideoPreview
          referenceVideo={referenceVideo}
          currentTimeMs={document.currentTimeMs ?? 0}
          transportState={transportState}
          onCurrentTimeChange={(currentTimeMs) => {
            setDocument((current) => ({ ...current, currentTimeMs }))
          }}
          onError={setLoadError}
        />

        <section
          ref={editorWorkbenchRef}
          className="editor-workbench"
          aria-label="Subtitle timeline editor"
        >
          <TimelineWorkbench
            document={document}
            selection={selection}
            viewport={viewport}
            minPixelsPerSecond={minPixelsPerSecond}
            clipboard={clipboard}
            history={history}
            assets={assets}
            extensions={[textExtension]}
            showAssetsPanel={false}
            showPreviewPanel={false}
            transportState={transportState}
            onTransportStateChange={setTransportState}
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
