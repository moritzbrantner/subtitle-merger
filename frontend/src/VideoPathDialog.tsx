import { useEffect, useRef, useState, type FormEvent } from 'react'
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

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

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
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)
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

    setPath('')
    setValidationError(undefined)
  }, [open])

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

    const focusFrame = window.requestAnimationFrame(() => pathInputRef.current?.focus())

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
    <div
      ref={overlayRef}
      className="video-path-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        ref={dialogRef}
        className="video-path-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-path-heading"
      >
        <div className="video-path-heading">
          <div>
            <p className="eyebrow">{messages.openVideoEyebrow}</p>
            <h2 id="video-path-heading">{messages.openVideoHeading}</h2>
          </div>
          <button
            className="video-path-close"
            type="button"
            aria-label={messages.closeVideoDialog}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form className="video-path-form" onSubmit={submitPath}>
          <label>
            <span>{messages.videoPathLabel}</span>
            <input
              ref={pathInputRef}
              type="text"
              value={path}
              aria-describedby="video-path-help"
              disabled={isLoading}
              onChange={(event) => {
                setPath(event.currentTarget.value)
                setValidationError(undefined)
                onClearError()
              }}
            />
          </label>
          <p id="video-path-help" className="video-path-help">
            {messages.videoPathHelp}
          </p>

          {displayedError ? (
            <p className="video-path-error" role="alert">
              {displayedError}
            </p>
          ) : null}

          <div className="video-path-actions">
            <button type="button" className="video-path-secondary" onClick={onClose}>
              {messages.cancel}
            </button>
            <button type="submit" className="video-path-primary" disabled={isLoading}>
              {isLoading ? messages.opening : messages.loadVideo}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
