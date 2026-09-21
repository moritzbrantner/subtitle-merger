import { useEffect, useRef, useState, type FormEvent } from 'react'
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
import { Input } from '@moritzbrantner/ui/components/stable/input'
import { Label } from '@moritzbrantner/ui/components/stable/label'
import type { AppMessages } from './localization'
import './VideoPathDialog.css'

type VideoPathDialogProps = {
  open: boolean
  messages: AppMessages
  isLoading: boolean
  error?: string
  onClearError: () => void
  onClose: () => void
  onLoad: (path: string) => void
}

function restoreFileMenuFocus(event: Event) {
  const fileButton = window.document.querySelector<HTMLElement>(
    'button[aria-controls="file-menu"]',
  )
  if (!fileButton) return

  event.preventDefault()
  fileButton.focus()
}

export function VideoPathDialog({
  open,
  messages,
  isLoading,
  error,
  onClearError,
  onClose,
  onLoad,
}: VideoPathDialogProps) {
  const [path, setPath] = useState('')
  const [validationError, setValidationError] = useState<string>()
  const pathInputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const opening = open && !wasOpenRef.current
    wasOpenRef.current = open

    if (!opening) {
      return
    }

    setPath('')
    setValidationError(undefined)
  }, [open])

  const displayedError = validationError ?? error

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedPath = path.trim()

    if (!normalizedPath) {
      setValidationError(messages.videoPathRequired)
      return
    }

    setValidationError(undefined)
    onLoad(normalizedPath)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        className="video-path-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          pathInputRef.current?.focus()
        }}
        onCloseAutoFocus={restoreFileMenuFocus}
      >
        <DialogHeader className="video-path-heading">
          <div>
            <p className="eyebrow">{messages.openVideoEyebrow}</p>
            <DialogTitle>{messages.openVideoHeading}</DialogTitle>
          </div>
          <DialogClose asChild>
            <Button
              className="video-path-close"
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={messages.closeVideoDialog}
            >
              ×
            </Button>
          </DialogClose>
        </DialogHeader>

        <form className="video-path-form" onSubmit={submitPath}>
          <div className="video-path-field">
            <Label htmlFor="video-path-input">{messages.videoPathLabel}</Label>
            <Input
              ref={pathInputRef}
              id="video-path-input"
              type="text"
              value={path}
              aria-describedby="video-path-help"
              aria-invalid={Boolean(displayedError) || undefined}
              disabled={isLoading}
              onChange={(event) => {
                setPath(event.currentTarget.value)
                setValidationError(undefined)
                onClearError()
              }}
            />
          </div>
          <DialogDescription id="video-path-help" className="video-path-help">
            {messages.videoPathHelp}
          </DialogDescription>

          {displayedError ? (
            <p className="video-path-error" role="alert">
              {displayedError}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {messages.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? messages.opening : messages.loadVideo}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
