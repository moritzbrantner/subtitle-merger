import {
  getTimelineTextCuesAt,
  getTimelineTextStyleForCue,
  type TimelineTextAlignment,
  type TimelineTextCue,
  type TimelineTextStyle,
} from '@moritzbrantner/timeline-editor/text'
import type { SubtitleDocument } from './subtitle-session'

export type ActiveSubtitlePreviewCue = {
  key: string
  trackId: string
  trackLabel: string
  cue: TimelineTextCue
  style?: TimelineTextStyle
  alignment: TimelineTextAlignment
}

export function getActiveSubtitlePreviewCues(
  document: SubtitleDocument,
  currentTimeMs: number,
): ActiveSubtitlePreviewCue[] {
  return document.tracks.flatMap((track) =>
    track.items.flatMap((item) => {
      if (
        item.data?.mediaType !== 'text' ||
        currentTimeMs < item.startMs ||
        currentTimeMs > item.startMs + item.durationMs
      ) {
        return []
      }

      const offsetMs = Math.max(0, currentTimeMs - item.startMs)
      return getTimelineTextCuesAt(item.data, offsetMs).map((cue, index) => {
        const style = getTimelineTextStyleForCue(item.data, cue)

        return {
          key:
            cue.id ??
            `${track.id}-${item.id}-${cue.startMs}-${cue.endMs}-${index}`,
          trackId: track.id,
          trackLabel: track.label,
          cue,
          style,
          alignment: cue.alignment ?? style?.alignment ?? 'bottom-center',
        }
      })
    }),
  )
}
