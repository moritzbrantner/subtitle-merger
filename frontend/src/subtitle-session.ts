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

function getSpeakers(asset: SubtitleAsset): string[] {
  const speakers: string[] = []
  const seen = new Set<string>()

  for (const cue of asset.data?.cues ?? []) {
    const speaker = cue.actor?.trim()

    if (speaker && !seen.has(speaker)) {
      seen.add(speaker)
      speakers.push(speaker)
    }
  }

  return speakers
}

function getSpeakerSummary(speakers: string[]): string | undefined {
  if (speakers.length === 0) {
    return undefined
  }

  const visible = speakers.slice(0, 3)
  const remaining = speakers.length - visible.length

  return remaining > 0 ? `${visible.join(', ')} +${remaining}` : visible.join(', ')
}

function getTrackLabel(asset: SubtitleAsset, speakers: string[]): string {
  const speakerSummary = getSpeakerSummary(speakers)
  return speakerSummary ? `${asset.label} · ${speakerSummary}` : asset.label
}

export function buildSubtitleSession(
  referenceVideoDurationMs: number,
  assets: SubtitleAsset[],
): SubtitleSession {
  const tracks = assets.map((asset) => {
    const trackId = `subtitle-${asset.id}`
    const speakers = getSpeakers(asset)
    const trackLabel = getTrackLabel(asset, speakers)
    const cueSequenceDurationMs = Math.max(getLastCueEndMs(asset), 1)

    return {
      id: trackId,
      label: trackLabel,
      kind: 'text',
      acceptsItemKinds: ['text', 'subtitle', 'caption'],
      height: 72,
      data: {
        exportLabel: asset.label,
        speakers,
      },
      items: [
        {
          id: `${asset.id}-item`,
          trackId,
          label: trackLabel,
          startMs: 0,
          durationMs: cueSequenceDurationMs,
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
