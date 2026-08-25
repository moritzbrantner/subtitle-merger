import { describe, expect, it, vi } from 'vitest'
import {
  downloadSubtitleExport,
  resolveExportTrackId,
  type SubtitleDownloadEnvironment,
} from './subtitle-export-ui'

describe('subtitle export UI helpers', () => {
  it('prefers the currently selected editable timeline track', () => {
    const tracks = [
      { id: 'source', label: 'Subtitles', language: 'en' },
      { id: 'translation', label: 'Translation', language: 'de' },
    ]

    expect(resolveExportTrackId(tracks, ['other', 'translation'])).toBe('translation')
    expect(resolveExportTrackId(tracks, ['other'])).toBe('source')
    expect(resolveExportTrackId([], ['translation'])).toBeUndefined()
  })

  it('downloads the generated text with its filename and releases the object URL', async () => {
    let capturedBlob: Blob | undefined
    const createObjectUrl = vi.fn((blob: Blob) => {
      capturedBlob = blob
      return 'blob:subtitle-export'
    })
    const revokeObjectUrl = vi.fn()
    const download = vi.fn()
    const environment: SubtitleDownloadEnvironment = {
      createObjectUrl,
      revokeObjectUrl,
      download,
    }

    downloadSubtitleExport(
      {
        filename: 'subtitles-en.srt',
        mimeType: 'application/x-subrip;charset=utf-8',
        text: '1\n00:00:00,000 --> 00:00:01,000\nHello\n',
      },
      environment,
    )

    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledWith('blob:subtitle-export', 'subtitles-en.srt')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:subtitle-export')
    expect(capturedBlob).toBeDefined()
    expect(capturedBlob?.type).toBe('application/x-subrip;charset=utf-8')
    expect(await capturedBlob?.text()).toContain('Hello')
  })
})
