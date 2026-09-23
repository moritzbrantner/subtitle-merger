import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import {
  TimelineWorkbench,
  type TimelineEditorExtension,
} from '@moritzbrantner/timeline-editor'
import { createTimelineAudioExtension } from '@moritzbrantner/timeline-editor/audio'
import { createTimelineTextExtension } from '@moritzbrantner/timeline-editor/text'
import { SubtitleExportDialog } from './SubtitleExportDialog'
import { VideoPathDialog } from './VideoPathDialog'
import { AppHeader } from './app/AppHeader'
import { GenerationPanel } from './app/GenerationPanel'
import { ReferenceVideoPreview } from './app/ReferenceVideoPreview'
import { StatusMessages } from './app/StatusMessages'
import { useReferenceVideoLoader } from './app/useReferenceVideoLoader'
import { useSubtitleEditorSession } from './app/useSubtitleEditorSession'
import { useSubtitleGeneration } from './generation/useSubtitleGeneration'
import type { SubtitleAsset, TimelineItemData } from './subtitle-session'
import { getFitTimelinePixelsPerSecond } from './timeline-viewport'
import { applyAppearance, getPreferredAppearance, type Appearance } from './appearance'
import { getMessages, getPreferredLocale, persistLocale, type Locale } from './localization'
import './App.css'

type EditorExtension = TimelineEditorExtension<TimelineItemData>

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
  const [previewError, setPreviewError] = useState<string>()
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const messages = useMemo(() => getMessages(locale), [locale])
  const textExtension = useMemo(
    () => createTimelineTextExtension() as unknown as EditorExtension,
    [],
  )
  const audioExtension = useMemo(
    () => createTimelineAudioExtension() as unknown as EditorExtension,
    [],
  )
  const editorSession = useSubtitleEditorSession()
  const {
    document,
    selection,
    viewport,
    clipboard,
    history,
    assets,
    transportState,
    replaceSession,
    appendAssets,
    attachReferenceAudio,
  } = editorSession

  const commitLoadedSession = useCallback(
    (referenceVideoDurationMs: number, nextAssets: SubtitleAsset[]) => {
      setPreviewError(undefined)
      replaceSession(referenceVideoDurationMs, nextAssets)
    },
    [replaceSession],
  )

  const videoLoader = useReferenceVideoLoader({
    messages,
    onSessionLoaded: (referenceVideo, nextAssets) =>
      commitLoadedSession(referenceVideo.durationMs, nextAssets),
    onReferenceAudioLoaded: attachReferenceAudio,
  })

  const commitGeneratedAssets = useCallback(
    (generatedAssets: SubtitleAsset[]) => {
      const durationMs = videoLoader.referenceVideo?.durationMs

      if (durationMs !== undefined) {
        appendAssets(durationMs, generatedAssets)
      }
    },
    [appendAssets, videoLoader.referenceVideo?.durationMs],
  )

  const generation = useSubtitleGeneration({
    messages,
    video: videoLoader.selectedVideo,
    referenceVideoDurationMs: videoLoader.referenceVideo?.durationMs,
    onCompletedAssets: commitGeneratedAssets,
  })

  const editorWorkbenchRef = useRef<HTMLElement>(null)
  const editorViewportWidthPx = useTimelineViewportWidth(editorWorkbenchRef)
  const minPixelsPerSecond = useMemo(
    () => getFitTimelinePixelsPerSecond(document.durationMs ?? 0, editorViewportWidthPx),
    [document.durationMs, editorViewportWidthPx],
  )
  const emptyState =
    videoLoader.referenceVideo && assets.length === 0
      ? messages.emptyTracks
      : undefined

  useEffect(() => {
    persistLocale(locale)
  }, [locale])

  useEffect(() => applyAppearance(appearance), [appearance])

  return (
    <main className="editor-shell">
      <AppHeader
        messages={messages}
        locale={locale}
        appearance={appearance}
        onOpenVideo={videoLoader.openVideoDialog}
        onOpenExport={() => setIsExportDialogOpen(true)}
        onLocaleChange={setLocale}
        onAppearanceChange={setAppearance}
      />

      <div className="editor-content">
        <div className="editor-status-region">
          <StatusMessages
            error={previewError}
            warnings={videoLoader.loadWarnings}
            emptyState={emptyState}
          />
        </div>

        <div
          className={
            videoLoader.selectedVideo
              ? 'editor-upper-workspace'
              : 'editor-upper-workspace editor-upper-workspace--viewer-only'
          }
        >
          <ReferenceVideoPreview
            referenceVideo={videoLoader.referenceVideo}
            document={document}
            currentTimeMs={document.currentTimeMs ?? 0}
            transportState={transportState}
            onCurrentTimeChange={editorSession.setCurrentTimeMs}
            onError={setPreviewError}
            messages={messages}
          />

          {videoLoader.selectedVideo ? (
            <aside className="editor-sidebar" aria-label={messages.automaticSubtitles}>
              <GenerationPanel
                messages={messages}
                locale={locale}
                targetLanguage={generation.targetLanguage}
                diarize={generation.diarize}
                isGenerating={generation.isGenerating}
                generationMessage={generation.generationMessage}
                onTargetLanguageChange={generation.setTargetLanguage}
                onDiarizeChange={generation.setDiarize}
                onGenerate={() => void generation.generate()}
              />
            </aside>
          ) : null}
        </div>

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
            extensions={[audioExtension, textExtension]}
            showAssetsPanel={false}
            showPreviewPanel={false}
            transportState={transportState}
            onTransportStateChange={editorSession.workbench.onTransportStateChange}
            onDocumentChange={editorSession.workbench.onDocumentChange}
            onSelectionChange={editorSession.workbench.onSelectionChange}
            onViewportChange={editorSession.workbench.onViewportChange}
            onClipboardChange={editorSession.workbench.onClipboardChange}
            onHistoryChange={editorSession.workbench.onHistoryChange}
          />
        </section>
      </div>

      <VideoPathDialog
        open={videoLoader.isVideoPathDialogOpen}
        messages={messages}
        isLoading={videoLoader.isLoadingVideo}
        error={videoLoader.videoPathError}
        onClearError={videoLoader.clearVideoPathError}
        onClose={videoLoader.closeVideoDialog}
        onLoad={(path) => void videoLoader.loadVideo(path)}
      />

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
