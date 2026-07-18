import {
  timelineEditorMaxPixelsPerSecond,
  timelineEditorMinPixelsPerSecond,
} from '@moritzbrantner/timeline-editor'
import { describe, expect, it } from 'vitest'
import { getFitTimelinePixelsPerSecond } from './timeline-viewport'

describe('getFitTimelinePixelsPerSecond', () => {
  it('fits a long Reference Video into the available timeline width', () => {
    expect(getFitTimelinePixelsPerSecond(5_400_000, 1_100)).toBeCloseTo(0.168, 3)
  })

  it('keeps the package default until the timeline has a measurable width', () => {
    expect(getFitTimelinePixelsPerSecond(5_400_000, 0)).toBe(
      timelineEditorMinPixelsPerSecond,
    )
  })

  it('does not move the minimum beyond the maximum zoom for a short video', () => {
    expect(getFitTimelinePixelsPerSecond(1_000, 1_100)).toBe(
      timelineEditorMaxPixelsPerSecond,
    )
  })
})
