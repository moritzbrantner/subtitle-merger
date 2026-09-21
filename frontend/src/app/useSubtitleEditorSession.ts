import { useCallback, useMemo, useReducer, useRef } from 'react'
import {
  createTimelineEditorHistory,
  type TimelineEditorClipboard,
  type TimelineEditorHistory,
  type TimelineEditorSelection,
  type TimelineEditorViewport,
  type TimelineWorkbenchTransportState,
} from '@moritzbrantner/timeline-editor'
import type { ReferenceVideoAudio } from '../reference-video-audio'
import {
  attachReferenceAudio,
  buildSubtitleSession,
  createEmptySubtitleDocument,
  type SubtitleAsset,
  type SubtitleDocument,
  type SubtitleSession,
  type TimelineItemData,
} from '../subtitle-session'

type EditorHistory = TimelineEditorHistory<Record<string, unknown>, TimelineItemData>

type SubtitleEditorSessionState = {
  document: SubtitleDocument
  selection: TimelineEditorSelection
  viewport: TimelineEditorViewport
  clipboard: TimelineEditorClipboard<TimelineItemData> | undefined
  history: EditorHistory
  assets: SubtitleAsset[]
  transportState: TimelineWorkbenchTransportState
}

type SubtitleEditorSessionAction =
  | { type: 'replace-session'; session: SubtitleSession }
  | { type: 'merge-session'; session: SubtitleSession }
  | {
      type: 'attach-reference-audio'
      referenceVideoDurationMs: number
      referenceAudio: ReferenceVideoAudio
    }
  | { type: 'set-current-time'; currentTimeMs: number }
  | { type: 'document-changed'; document: SubtitleDocument }
  | { type: 'selection-changed'; selection: TimelineEditorSelection }
  | { type: 'viewport-changed'; viewport: TimelineEditorViewport }
  | {
      type: 'clipboard-changed'
      clipboard: TimelineEditorClipboard<TimelineItemData> | undefined
    }
  | { type: 'history-changed'; history: EditorHistory }
  | { type: 'transport-changed'; transportState: TimelineWorkbenchTransportState }

const defaultTransportState: TimelineWorkbenchTransportState = {
  status: 'paused',
  playbackRate: 1,
  loop: false,
}

function createEditorHistory(): EditorHistory {
  return createTimelineEditorHistory() as EditorHistory
}

export function createSubtitleEditorSessionInitialState(): SubtitleEditorSessionState {
  return {
    document: createEmptySubtitleDocument(),
    selection: { itemIds: [], trackIds: [] },
    viewport: { pixelsPerSecond: 80 },
    clipboard: undefined,
    history: createEditorHistory(),
    assets: [],
    transportState: defaultTransportState,
  }
}

export function reduceSubtitleEditorSession(
  state: SubtitleEditorSessionState,
  action: SubtitleEditorSessionAction,
): SubtitleEditorSessionState {
  switch (action.type) {
    case 'replace-session':
      return {
        ...state,
        assets: action.session.assets,
        document: action.session.document,
        selection: action.session.selection,
        viewport: { pixelsPerSecond: 80 },
        clipboard: undefined,
        history: createEditorHistory(),
        transportState: defaultTransportState,
      }
    case 'merge-session':
      return {
        ...state,
        assets: action.session.assets,
        document: action.session.document,
        selection: action.session.selection,
      }
    case 'attach-reference-audio':
      return {
        ...state,
        document: attachReferenceAudio(
          state.document,
          action.referenceVideoDurationMs,
          action.referenceAudio,
        ),
      }
    case 'set-current-time':
      return {
        ...state,
        document: { ...state.document, currentTimeMs: action.currentTimeMs },
      }
    case 'document-changed':
      return { ...state, document: action.document }
    case 'selection-changed':
      return { ...state, selection: action.selection }
    case 'viewport-changed':
      return { ...state, viewport: action.viewport }
    case 'clipboard-changed':
      return { ...state, clipboard: action.clipboard }
    case 'history-changed':
      return { ...state, history: action.history }
    case 'transport-changed':
      return { ...state, transportState: action.transportState }
  }
}

export function useSubtitleEditorSession() {
  const [state, dispatch] = useReducer(
    reduceSubtitleEditorSession,
    undefined,
    createSubtitleEditorSessionInitialState,
  )
  const assetsRef = useRef<SubtitleAsset[]>([])
  const referenceAudioRef = useRef<ReferenceVideoAudio | undefined>(undefined)

  const replaceSession = useCallback(
    (referenceVideoDurationMs: number, assets: SubtitleAsset[]) => {
      assetsRef.current = assets
      referenceAudioRef.current = undefined
      dispatch({
        type: 'replace-session',
        session: buildSubtitleSession(referenceVideoDurationMs, assets),
      })
    },
    [],
  )

  const appendAssets = useCallback(
    (referenceVideoDurationMs: number, assets: SubtitleAsset[]) => {
      const nextAssets = [...assetsRef.current, ...assets]
      assetsRef.current = nextAssets
      dispatch({
        type: 'merge-session',
        session: buildSubtitleSession(
          referenceVideoDurationMs,
          nextAssets,
          referenceAudioRef.current,
        ),
      })
    },
    [],
  )

  const attachReferenceAudioToSession = useCallback(
    (referenceVideoDurationMs: number, referenceAudio: ReferenceVideoAudio) => {
      referenceAudioRef.current = referenceAudio
      dispatch({
        type: 'attach-reference-audio',
        referenceVideoDurationMs,
        referenceAudio,
      })
    },
    [],
  )

  const setCurrentTimeMs = useCallback((currentTimeMs: number) => {
    dispatch({ type: 'set-current-time', currentTimeMs })
  }, [])

  const workbench = useMemo(
    () => ({
      onDocumentChange: (document: SubtitleDocument) =>
        dispatch({ type: 'document-changed', document }),
      onSelectionChange: (selection: TimelineEditorSelection) =>
        dispatch({ type: 'selection-changed', selection }),
      onViewportChange: (viewport: TimelineEditorViewport) =>
        dispatch({ type: 'viewport-changed', viewport }),
      onClipboardChange: (clipboard: TimelineEditorClipboard<TimelineItemData> | undefined) =>
        dispatch({ type: 'clipboard-changed', clipboard }),
      onHistoryChange: (history: EditorHistory) => dispatch({ type: 'history-changed', history }),
      onTransportStateChange: (transportState: TimelineWorkbenchTransportState) =>
        dispatch({ type: 'transport-changed', transportState }),
    }),
    [],
  )

  return {
    ...state,
    replaceSession,
    appendAssets,
    attachReferenceAudio: attachReferenceAudioToSession,
    setCurrentTimeMs,
    workbench,
  }
}
