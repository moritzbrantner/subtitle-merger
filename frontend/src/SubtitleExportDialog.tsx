import { useEffect, useMemo, useRef, useState } from 'react'
import {
  exportSubtitleTrack,
  listEditableSubtitleTracks,
  type SubtitleExportFormat,
} from './subtitle-export'
import { downloadSubtitleExport, resolveExportTrackId } from './subtitle-export-ui'
import type { SubtitleDocument } from './subtitle-session'
import { getMessages, type Locale } from './localization'
import './SubtitleExportDialog.css'

type SubtitleExportDialogProps = {
  open: boolean
  document: SubtitleDocument
  selectedTrackIds?: string[]
  locale: Locale
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
  locale,
  onClose,
}: SubtitleExportDialogProps) {
  const messages = getMessages(locale)
  const tracks = useMemo(() => listEditableSubtitleTracks(subtitleDocument), [subtitleDocument])
  const [trackId, setTrackId] = useState('')
  const [format, setFormat] = useState<SubtitleExportFormat>('srt')
  const [error, setError] = useState<string>()
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const trackSelectRef = useRef<HTMLSelectElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

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

    const activeElement = window.document.activeElement
    const previousFocus =
      activeElement instanceof HTMLElement && activeElement !== window.document.body
        ? activeElement
        : null
    const overlay = overlayRef.current
    const siblings = overlay?.parentElement
      ? Array.from(overlay.parentElement.children).filter((element) => element !== overlay)
      : []
    const previousInert = siblings.map((element) => [element, (element as HTMLElement).inert] as const)

    for (const element of siblings) {
      ;(element as HTMLElement).inert = true
    }

    const focusFrame = window.requestAnimationFrame(() => {
      ;(trackSelectRef.current ?? closeButtonRef.current)?.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
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
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeyDown)
      for (const [element, inert] of previousInert) {
        ;(element as HTMLElement).inert = inert
      }

      const restoreTarget = previousFocus?.isConnected
        ? previousFocus
        : window.document.querySelector<HTMLElement>('button[aria-controls="file-menu"]')
      restoreTarget?.focus()
    }
  }, [open])

  if (!open) {
    return null
  }

  function exportTrack() {
    if (!trackId) {
      setError(messages.chooseTrack)
      return
    }

    try {
      downloadSubtitleExport(exportSubtitleTrack(subtitleDocument, trackId, format))
      onClose()
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : messages.exportFailed)
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
            <p className="eyebrow">{messages.exportEyebrow}</p>
            <h2 id="subtitle-export-heading">{messages.exportHeading}</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="subtitle-export-close"
            type="button"
            aria-label={messages.closeExportDialog}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {tracks.length > 0 ? (
          <div className="subtitle-export-fields">
            <label>
              {messages.track}
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
              <legend>{messages.format}</legend>
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
            {messages.noEditableTracks}
          </p>
        )}

        {error ? <p className="subtitle-export-error" role="alert">{error}</p> : null}

        <div className="subtitle-export-actions">
          <button type="button" className="subtitle-export-secondary" onClick={onClose}>
            {messages.cancel}
          </button>
          <button
            type="button"
            className="subtitle-export-primary"
            disabled={tracks.length === 0 || !trackId}
            onClick={exportTrack}
          >
            {messages.export}
          </button>
        </div>
      </section>
    </div>
  )
}
