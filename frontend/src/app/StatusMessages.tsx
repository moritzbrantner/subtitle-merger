import type { LoadWarning } from '../video-load'

type StatusMessagesProps = {
  error?: string
  warnings: LoadWarning[]
  emptyState?: string
}

export function StatusMessages({ error, warnings, emptyState }: StatusMessagesProps) {
  return (
    <>
      {error ? (
        <div className="load-error" role="alert">
          {error}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="load-warning" role="status">
          <ul>
            {warnings.map((warning) => (
              <li key={`${warning.filename}-${warning.message}`}>
                <strong>{warning.filename}</strong>: {warning.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {emptyState ? (
        <div className="empty-state" role="status">
          {emptyState}
        </div>
      ) : null}
    </>
  )
}
