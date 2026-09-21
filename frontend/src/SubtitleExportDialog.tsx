import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@moritzbrantner/ui/components/stable/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@moritzbrantner/ui/components/stable/dialog'
import { Label } from '@moritzbrantner/ui/components/stable/label'
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

function restoreFileMenuFocus(event: Event) {
  const fileButton = window.document.querySelector<HTMLElement>(
    'button[aria-controls="file-menu"]',
  )
  if (!fileButton) return

  event.preventDefault()
  fileButton.focus()
}

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
  const trackSelectRef = useRef<HTMLSelectElement>(null)
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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        className="subtitle-export-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          if (!trackSelectRef.current) return
          event.preventDefault()
          trackSelectRef.current.focus()
        }}
        onCloseAutoFocus={restoreFileMenuFocus}
      >
        <DialogHeader className="subtitle-export-heading">
          <div>
            <DialogDescription className="eyebrow">{messages.exportEyebrow}</DialogDescription>
            <DialogTitle>{messages.exportHeading}</DialogTitle>
          </div>
          <DialogClose asChild>
            <Button
              className="subtitle-export-close"
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={messages.closeExportDialog}
            >
              ×
            </Button>
          </DialogClose>
        </DialogHeader>

        {tracks.length > 0 ? (
          <div className="subtitle-export-fields">
            <div className="subtitle-export-field">
              <Label htmlFor="subtitle-export-track">{messages.track}</Label>
              <select
                ref={trackSelectRef}
                id="subtitle-export-track"
                value={trackId}
                onChange={(event) => setTrackId(event.currentTarget.value)}
              >
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.label}
                  </option>
                ))}
              </select>
            </div>

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
          <p className="subtitle-export-empty">{messages.noEditableTracks}</p>
        )}

        {error ? (
          <p className="subtitle-export-error" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {messages.cancel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={tracks.length === 0 || !trackId}
            onClick={exportTrack}
          >
            {messages.export}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
