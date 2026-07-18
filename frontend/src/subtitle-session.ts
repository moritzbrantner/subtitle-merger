import type {
  TimelineEditorDocument,
  TimelineEditorSelection,
  TimelineWorkbenchAsset,
} from '@moritzbrantner/timeline-editor'
import type { TimelineTextItemData } from '@moritzbrantner/timeline-editor/text'

export type SubtitleAsset = TimelineWorkbenchAsset<TimelineTextItemData>
export type SubtitleDocument = TimelineEditorDocument<Record<string, unknown>, TimelineTextItemData>

export type SubtitleSession = {
  assets: SubtitleAsset[]
  document: SubtitleDocument
  selection: TimelineEditorSelection
}

function getLastCueEndMs(asset: SubtitleAsset): number {
  return Math.max(0, ...(asset.data?.cues ?? []).map((cue) => cue.endMs))
}

export function buildSubtitleSession(
  referenceVideoDurationMs: number,
  assets: SubtitleAsset[],
): SubtitleSession {
  const tracks = assets.map((asset) => {
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
          kind: 'text',
          color: asset.color,
          data: asset.data,
        },
      ],
    }
  })
  const itemIds = tracks.flatMap((track) => track.items.map((item) => item.id))
  const trackIds = tracks.map((track) => track.id)

  return {
    assets,
    document: {
      durationMs: Math.max(
        referenceVideoDurationMs,
        ...assets.map(getLastCueEndMs),
        1_000,
      ),
      currentTimeMs: 0,
      tracks,
    },
    selection: {
      itemIds,
      anchorItemId: itemIds[0],
      trackIds,
    },
  }
}

export function createEmptySubtitleDocument(): SubtitleDocument {
  return {
    durationMs: 30_000,
    currentTimeMs: 0,
    tracks: [],
  }
}
