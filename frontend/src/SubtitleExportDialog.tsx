import { useEffect, useMemo, useState } from 'react'
import {
  exportSubtitleTrack,
  listEditableSubtitleTracks,
  type SubtitleExportFormat,
} from './subtitle-export'
import { downloadSubtitleExport, resolveExportTrackId } from './subtitle-export-ui'
import type { SubtitleDocument } from './subtitle-session'
import './SubtitleExportDialog.css'

type SubtitleExportDialogProps = {
  open: boolean
  document: SubtitleDocument
  selectedTrackIds?: string[]
  onClose: () => void
}

export function SubtitleExportDialog({
  open,
  document,
  selectedTrackIds = [],
  onClose,
}: SubtitleExportDialogProps) {
  const tracks = useMemo(() => listEditableSubtitleTracks(document), [document])
  const [trackId, setTrackId] = useState('')
  const [format, setFormat] = useState<SubtitleExportFormat>('srt')
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) {
      return
    }

    setTrackId(resolveExportTrackId(tracks, selectedTrackIds) ?? '')
    setFormat('srt')
    setError(undefined)
  }, [open, selectedTrackIds, tracks])

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!open) {
    return null
  }

  function exportTrack() {
    if (!trackId) {
      setError('Choose an editable subtitle track to export.')
      return
    }

    try {
      downloadSubtitleExport(exportSubtitleTrack(document, trackId, format))
      onClose()
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Could not export subtitles.')
    }
  }

  return (
    <div
      className="subtitle-export-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        className="subtitle-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subtitle-export-heading"
      >
        <div className="subtitle-export-heading">
          <div>
            <p className="eyebrow">Export subtitles</p>
            <h2 id="subtitle-export-heading">Save the current edited track</h2>
          </div>
          <button
            className="subtitle-export-close"
            type="button"
            aria-label="Close export dialog"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {tracks.length > 0 ? (
          <div className="subtitle-export-fields">
            <label>
              Track
              <select value={trackId} onChange={(event) => setTrackId(event.currentTarget.value)}>
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.label}{track.language ? ` — ${track.language.toUpperCase()}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <fieldset>
              <legend>Format</legend>
              <label>
                <input
                  type="radio"
                  name="subtitle-export-format"
                  value="srt"
                  checked={format === 'srt'}
                  onChange={() => setFormat('srt')}
                />
                SRT
              </label>
              <label>
                <input
                  type="radio"
                  name="subtitle-export-format"
                  value="webvtt"
                  checked={format === 'webvtt'}
                  onChange={() => setFormat('webvtt')}
                />
                WebVTT
              </label>
            </fieldset>
          </div>
        ) : (
          <p className="subtitle-export-empty">
            No editable subtitle tracks are available yet. Load or generate subtitles first.
          </p>
        )}

        {error ? <p className="subtitle-export-error" role="alert">{error}</p> : null}

        <div className="subtitle-export-actions">
          <button type="button" className="subtitle-export-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="subtitle-export-primary"
            disabled={tracks.length === 0 || !trackId}
            onClick={exportTrack}
          >
            Export
          </button>
        </div>
      </section>
    </div>
  )
}
