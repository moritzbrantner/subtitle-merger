import { useEffect, useMemo, useRef, useState } from 'react'
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

const focusableSelector = [
  'button:not([disabled])',
  'select:not([disabled])',
  'input:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function SubtitleExportDialog({
  open,
  document: subtitleDocument,
  selectedTrackIds,
  onClose,
}: SubtitleExportDialogProps) {
  const tracks = useMemo(() => listEditableSubtitleTracks(subtitleDocument), [subtitleDocument])
  const [trackId, setTrackId] = useState('')
  const [format, setFormat] = useState<SubtitleExportFormat>('srt')
  const [error, setError] = useState<string>()
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const trackSelectRef = useRef<HTMLSelectElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const opening = open && !wasOpenRef.current
    wasOpenRef.current = open

    if (!opening) {
      return
    }

    setTrackId(resolveExportTrackId(tracks, selectedTrackIds ?? []) ?? '')
    setFormat('srt')
    setError(undefined)
  }, [open, selectedTrackIds, tracks])

  useEffect(() => {
    if (!open || tracks.some((track) => track.id === trackId)) {
      return
    }

    setTrackId(resolveExportTrackId(tracks, selectedTrackIds ?? []) ?? '')
  }, [open, selectedTrackIds, trackId, tracks])

  useEffect(() => {
    if (!open) {
      return
    }

    const previousFocus = window.document.activeElement as HTMLElement | null
    const overlay = overlayRef.current
    const siblings = overlay?.parentElement
      ? Array.from(overlay.parentElement.children).filter((element) => element !== overlay)
      : []
    const previousInert = siblings.map((element) => [element, (element as HTMLElement).inert] as const)

    for (const element of siblings) {
      ;(element as HTMLElement).inert = true
    }

    const focusInitialControl = () => {
      ;(trackSelectRef.current ?? closeButtonRef.current)?.focus()
    }
    window.requestAnimationFrame(focusInitialControl)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab') {
        return
      }

      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      )

      if (controls.length === 0) {
        event.preventDefault()
        return
      }

      const first = controls[0]!
      const last = controls.at(-1)!
      const active = window.document.activeElement

      if (!dialogRef.current?.contains(active)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.cancelAnimationFrame(window.requestAnimationFrame(() => undefined))
      window.removeEventListener('keydown', handleKeyDown)
      for (const [element, inert] of previousInert) {
        ;(element as HTMLElement).inert = inert
      }

      const restoreTarget = previousFocus?.isConnected
        ? previousFocus
        : window.document.querySelector<HTMLElement>('button[aria-controls="file-menu"]')
      restoreTarget?.focus()
    }
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
      downloadSubtitleExport(exportSubtitleTrack(subtitleDocument, trackId, format))
      onClose()
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Could not export subtitles.')
    }
  }

  return (
    <div
      ref={overlayRef}
      className="subtitle-export-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        ref={dialogRef}
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
            ref={closeButtonRef}
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
              <select
                ref={trackSelectRef}
                value={trackId}
                onChange={(event) => setTrackId(event.currentTarget.value)}
              >
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.label}
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
