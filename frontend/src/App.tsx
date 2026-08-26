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
import { AppHeader } from './app/AppHeader'
import { GenerationPanel } from './app/GenerationPanel'
import { ReferenceVideoPreview } from './app/ReferenceVideoPreview'
import { probeReferenceVideoMetadata, type ReferenceVideo } from './app/reference-video'
import { StatusMessages } from './app/StatusMessages'
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
import { loadSubtitleAssets, requestVideoPick, type LoadedVideo, type LoadWarning } from './video-load'
import { getFitTimelinePixelsPerSecond } from './timeline-viewport'
import { applyAppearance, getPreferredAppearance, type Appearance } from './appearance'
import { getMessages, getPreferredLocale, persistLocale, type Locale } from './localization'
import './App.css'

type EditorHistory = TimelineEditorHistory<Record<string, unknown>, TimelineTextItemData>
type EditorExtension = TimelineEditorExtension<TimelineTextItemData>

const defaultTransportState: TimelineWorkbenchTransportState = {
  status: 'paused',
  playbackRate: 1,
  loop: false,
}

function createEditorHistory(): EditorHistory {
  return createTimelineEditorHistory() as EditorHistory
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

      const metadata = await probeReferenceVideoMetadata(result.load.video.mediaUrl, messages)
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
      <AppHeader
        messages={messages}
        locale={locale}
        appearance={appearance}
        isPickingVideo={isPickingVideo}
        onOpenVideo={() => void openVideo()}
        onOpenExport={() => setIsExportDialogOpen(true)}
        onLocaleChange={setLocale}
        onAppearanceChange={setAppearance}
      />

      <div className="editor-content">
        <StatusMessages
          error={loadError}
          warnings={loadWarnings}
          emptyState={emptyState}
        />
        {selectedVideo ? (
          <GenerationPanel
            messages={messages}
            locale={locale}
            targetLanguage={targetLanguage}
            diarize={diarize}
            isGenerating={isGenerating}
            generationMessage={generationMessage}
            onTargetLanguageChange={setTargetLanguage}
            onDiarizeChange={setDiarize}
            onGenerate={() => void generateSubtitles()}
          />
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