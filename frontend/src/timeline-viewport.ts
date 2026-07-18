import {
  timelineEditorMaxPixelsPerSecond,
  timelineEditorMinPixelsPerSecond,
  timelineEditorTrackHeaderWidthPx,
} from '@moritzbrantner/timeline-editor'

const timelineEndLabelGutterPx = 48

export function getFitTimelinePixelsPerSecond(
  durationMs: number,
  editorViewportWidthPx: number,
): number {
  if (durationMs <= 0 || editorViewportWidthPx <= timelineEditorTrackHeaderWidthPx) {
    return timelineEditorMinPixelsPerSecond
  }

  const durationSeconds = durationMs / 1_000
  const timelineWidthPx =
    editorViewportWidthPx - timelineEditorTrackHeaderWidthPx - timelineEndLabelGutterPx

  return Math.min(
    Math.max(timelineWidthPx, 1) / durationSeconds,
    timelineEditorMaxPixelsPerSecond,
  )
}
