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
import { SubtitleExportDialog } from './SubtitleExportDialog'
import {
  startSubtitleGeneration,
  subscribeSubtitleJob,
  type SubtitleJobSubscription,
} from './generation/client'
import { type GeneratedTrack, type SubtitleJob, type SubtitleJobUpdate } from './generation/types'
import {
  buildSubtitleSession,
  createEmptySubtitleDocument,
  type SubtitleAsset,
  type SubtitleDocument,
} from './subtitle-session'
import {
  loadSubtitleAssets,
  requestVideoPick,
  type LoadedVideo,
  type LoadWarning,
} from './video-load'
import { getFitTimelinePixelsPerSecond } from './timeline-viewport'
import {
  appearances,
  applyAppearance,
  getPreferredAppearance,
  type Appearance,
} from './appearance'
import {
  formatLanguageName,
  getMessages,
  getPreferredLocale,
  persistLocale,
  supportedLocales,
  type AppMessages,
  type Locale,
} from './localization'
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

const defaultTransportState: TimelineWorkbenchTransportState = {
  status: 'paused',
  playbackRate: 1,
  loop: false,
}
const languageOptions = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl'] as const

function createEditorHistory(): EditorHistory {
  return createTimelineEditorHistory() as EditorHistory
}

function probeVideoMetadata(mediaUrl: string, messages: AppMessages): Promise<VideoMetadata> {
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
  messages,
}: {
  referenceVideo?: ReferenceVideo
  currentTimeMs: number
  transportState: TimelineWorkbenchTransportState
  onCurrentTimeChange: (timeMs: number) => void
  onError: (message: string) => void
  messages: AppMessages
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
        onError(messages.playbackBlocked)
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

          if (Math.abs(nextTimeMs - currentTimeMs) > 120) {
            onCurrentTimeChange(nextTimeMs)
          }
        }}
        onError={() => {
          onError(messages.referenceVideoFailed)
        }}
      />
    </section>
  )
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => getPreferredLocale())
  const [appearance, setAppearance] = useState<Appearance>(() => getPreferredAppearance())
  const messages = useMemo(() => getMessages(locale), [locale])
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
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isPickingVideo, setIsPickingVideo] = useState(false)
  const [selectedVideo, setSelectedVideo] = useState<LoadedVideo>()
  const [loadWarnings, setLoadWarnings] = useState<LoadWarning[]>([])
  const [targetLanguage, setTargetLanguage] = useState('')
  const [diarize, setDiarize] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationMessage, setGenerationMessage] = useState<string>()
  const jobEventsRef = useRef<SubtitleJobSubscription | null>(null)
  const editorWorkbenchRef = useRef<HTMLElement>(null)
  const editorViewportWidthPx = useTimelineViewportWidth(editorWorkbenchRef)
  const minPixelsPerSecond = useMemo(
    () => getFitTimelinePixelsPerSecond(document.durationMs ?? 0, editorViewportWidthPx),
    [document.durationMs, editorViewportWidthPx],
  )

  useEffect(() => {
    persistLocale(locale)
  }, [locale])

  useEffect(() => applyAppearance(appearance), [appearance])

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
        ? messages.emptyTracks
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

      const metadata = await probeVideoMetadata(result.load.video.mediaUrl, messages)
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
      setLoadError(error instanceof Error ? error.message : messages.videoLoadFailed)
    } finally {
      setIsPickingVideo(false)
    }
  }

  async function generateSubtitles() {
    if (!selectedVideo) {
      return
    }

    setIsGenerating(true)
    setGenerationMessage(messages.preparingGeneration)

    try {
      const job = await startSubtitleGeneration({
        video: selectedVideo,
        targetLanguage: targetLanguage || undefined,
        diarize,
      })

      setGenerationMessage(messages.jobPhases[job.phase])
      jobEventsRef.current?.close()
      jobEventsRef.current = subscribeSubtitleJob(job.jobId, applySubtitleJobUpdate, {
        onProtocolError: () => setGenerationMessage(messages.generationRunning),
      })
    } catch (error) {
      setGenerationMessage(
        error instanceof Error ? error.message : messages.jobPhases.failed,
      )
    } finally {
      setIsGenerating(false)
    }
  }

  function applySubtitleJobUpdate(update: SubtitleJobUpdate) {
    if (update.kind === 'progress') {
      setGenerationMessage(`${messages.jobPhases[update.progress.phase]}…`)
      return
    }

    applySubtitleJob(update.job)
  }

  function applySubtitleJob(job: SubtitleJob) {
    setGenerationMessage(job.state === 'failed' && job.message ? job.message : `${messages.jobPhases[job.phase]}…`)
    if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed') {
      jobEventsRef.current?.close()
    }
    if (job.state !== 'completed') return
    const tracks = [
      job.sourceTrack ? { track: job.sourceTrack, label: messages.sourceTrack, color: '#2fbf71' } : undefined,
      job.translationTrack ? { track: job.translationTrack, label: messages.translationTrack, color: '#c084fc' } : undefined,
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
          <p className="eyebrow">{messages.appName}</p>
          <h1>{messages.title}</h1>
        </div>

        <nav className="menu-bar" aria-label={messages.mainMenu}>
          <button
            className="menu-trigger"
            type="button"
            aria-expanded={isFileMenuOpen}
            aria-controls="file-menu"
            aria-haspopup="menu"
            onClick={() => setIsFileMenuOpen((isOpen) => !isOpen)}
          >
            {messages.file}
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
                {isPickingVideo ? messages.opening : messages.openVideo}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsFileMenuOpen(false)
                  setIsExportDialogOpen(true)
                }}
              >
                {messages.exportSubtitles}
              </button>
            </div>
          ) : null}
        </nav>
        <div className="editor-preferences">
          <label className="preference-select">
            <span>{messages.language}</span>
            <select value={locale} onChange={(event) => setLocale(event.currentTarget.value as Locale)}>
              {supportedLocales.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {formatLanguageName(candidate, candidate)}
                </option>
              ))}
            </select>
          </label>
          <label className="preference-select">
            <span>{messages.appearance}</span>
            <select
              value={appearance}
              onChange={(event) => setAppearance(event.currentTarget.value as Appearance)}
            >
              {appearances.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate === 'system'
                    ? messages.appearanceSystem
                    : candidate === 'light'
                      ? messages.appearanceLight
                      : messages.appearanceDark}
                </option>
              ))}
            </select>
          </label>
        </div>
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
              <p className="eyebrow">{messages.automaticSubtitles}</p>
              <h2 id="generation-heading">{messages.generateSubtitles}</h2>
              <p>{messages.generationDescription}</p>
            </div>
            <label>
              {messages.translateTo}
              <select
                value={targetLanguage}
                onChange={(event) => setTargetLanguage(event.currentTarget.value)}
              >
                <option value="">{messages.noTranslation}</option>
                {languageOptions.map((code) => (
                  <option key={code} value={code}>{formatLanguageName(locale, code)}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={diarize}
                onChange={(event) => setDiarize(event.currentTarget.checked)}
              />
              {messages.identifySpeakers}
            </label>
            <button
              className="generate-button"
              type="button"
              disabled={isGenerating}
              onClick={() => void generateSubtitles()}
            >
              {isGenerating ? messages.starting : messages.generateSubtitles}
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
          messages={messages}
        />

        <section
          ref={editorWorkbenchRef}
          className="editor-workbench"
          aria-label={messages.timelineLabel}
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

      <SubtitleExportDialog
        open={isExportDialogOpen}
        document={document}
        selectedTrackIds={selection.trackIds}
        locale={locale}
        onClose={() => setIsExportDialogOpen(false)}
      />
    </main>
  )
}

export default App