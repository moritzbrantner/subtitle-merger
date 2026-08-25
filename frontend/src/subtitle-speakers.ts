import type { SubtitleAsset, SubtitleDocument } from './subtitle-session'

function normalizedSpeaker(value: string): string {
  return value.trim()
}

export function listSubtitleSpeakers(document: SubtitleDocument): string[] {
  const speakers: string[] = []
  const seen = new Set<string>()

  for (const track of document.tracks) {
    for (const item of track.items) {
      for (const cue of item.data?.cues ?? []) {
        const speaker = cue.actor ? normalizedSpeaker(cue.actor) : ''

        if (speaker && !seen.has(speaker)) {
          seen.add(speaker)
          speakers.push(speaker)
        }
      }
    }
  }

  return speakers
}

export function renameSubtitleSpeakerInDocument(
  document: SubtitleDocument,
  currentSpeaker: string,
  nextSpeaker: string,
): SubtitleDocument {
  const normalizedNextSpeaker = normalizedSpeaker(nextSpeaker)

  if (!normalizedNextSpeaker || normalizedNextSpeaker === currentSpeaker) {
    return document
  }

  return {
    ...document,
    tracks: document.tracks.map((track) => ({
      ...track,
      items: track.items.map((item) => ({
        ...item,
        data: item.data
          ? {
              ...item.data,
              cues: item.data.cues?.map((cue) =>
                cue.actor === currentSpeaker ? { ...cue, actor: normalizedNextSpeaker } : cue,
              ),
            }
          : item.data,
      })),
    })),
  }
}

export function renameSubtitleSpeakerInAssets(
  assets: SubtitleAsset[],
  currentSpeaker: string,
  nextSpeaker: string,
): SubtitleAsset[] {
  const normalizedNextSpeaker = normalizedSpeaker(nextSpeaker)

  if (!normalizedNextSpeaker || normalizedNextSpeaker === currentSpeaker) {
    return assets
  }

  return assets.map((asset) => ({
    ...asset,
    data: asset.data
      ? {
          ...asset.data,
          cues: asset.data.cues?.map((cue) =>
            cue.actor === currentSpeaker ? { ...cue, actor: normalizedNextSpeaker } : cue,
          ),
        }
      : asset.data,
  }))
}
