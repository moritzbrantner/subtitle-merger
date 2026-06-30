import { useEffect, useState } from 'react'
import './App.css'

type HealthState =
  | { status: 'checking' }
  | {
      status: 'online'
      service: string
      version: string
    }
  | {
      status: 'offline'
      message: string
    }

async function fetchHealth(): Promise<HealthState> {
  try {
    const response = await fetch('/api/health')

    if (!response.ok) {
      return {
        status: 'offline',
        message: `Backend returned ${response.status}`,
      }
    }

    const payload = (await response.json()) as {
      service?: unknown
      status?: unknown
      version?: unknown
    }

    if (
      payload.status !== 'ok' ||
      typeof payload.service !== 'string' ||
      typeof payload.version !== 'string'
    ) {
      return {
        status: 'offline',
        message: 'Backend returned an unexpected health response',
      }
    }

    return {
      status: 'online',
      service: payload.service,
      version: payload.version,
    }
  } catch (error) {
    return {
      status: 'offline',
      message: error instanceof Error ? error.message : 'Backend is unreachable',
    }
  }
}

function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' })

  async function refreshHealth() {
    setHealth({ status: 'checking' })
    setHealth(await fetchHealth())
  }

  useEffect(() => {
    void refreshHealth()
  }, [])

  return (
    <main className="app-shell">
      <section className="workspace">
        <div className="status-panel" aria-live="polite">
          <span className={`status-light status-light--${health.status}`} />
          <div>
            <p className="eyebrow">Backend</p>
            <h1>
              {health.status === 'online'
                ? 'Rust API connected'
                : health.status === 'checking'
                  ? 'Checking Rust API'
                  : 'Rust API offline'}
            </h1>
            <p className="status-copy">
              {health.status === 'online'
                ? `${health.service} ${health.version} is responding through the Vite proxy.`
                : health.status === 'checking'
                  ? 'Waiting for /api/health to respond.'
                  : health.message}
            </p>
          </div>
          <button type="button" onClick={() => void refreshHealth()}>
            Refresh
          </button>
        </div>

        <div className="stack-grid" aria-label="Project stack">
          <section>
            <p className="eyebrow">Backend</p>
            <h2>Rust + Axum</h2>
            <p>HTTP API service with a typed health endpoint and Cargo checks.</p>
          </section>
          <section>
            <p className="eyebrow">Frontend</p>
            <h2>React + TypeScript</h2>
            <p>Vite app with strict TypeScript, workspace scripts, and API proxying.</p>
          </section>
        </div>
      </section>
    </main>
  )
}

export default App
