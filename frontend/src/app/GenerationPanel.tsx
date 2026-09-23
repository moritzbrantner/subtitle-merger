import { useEffect, useState } from 'react'
import { fetchGenerationPreflight, type GenerationPreflight } from '../generation/client'
import { formatLanguageName, type AppMessages, type Locale } from '../localization'

const languageOptions = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl'] as const

type GenerationPanelProps = {
  messages: AppMessages
  locale: Locale
  targetLanguage: string
  diarize: boolean
  isGenerating: boolean
  generationMessage?: string
  onTargetLanguageChange: (language: string) => void
  onDiarizeChange: (enabled: boolean) => void
  onGenerate: () => void
}

export function GenerationPanel({
  messages, locale, targetLanguage, diarize, isGenerating, generationMessage,
  onTargetLanguageChange, onDiarizeChange, onGenerate,
}: GenerationPanelProps) {
  const [readiness, setReadiness] = useState<GenerationPreflight>()
  const [readinessError, setReadinessError] = useState<string>()
  useEffect(() => {
    const controller = new AbortController()
    void fetchGenerationPreflight(fetch, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setReadiness(value) },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setReadinessError(error instanceof Error ? error.message : messages.jobPhases.failed)
        }
      },
    )
    return () => controller.abort()
  }, [messages])

  return (
    <section className="generation-panel" aria-labelledby="generation-heading">
      <div>
        <p className="eyebrow">{messages.automaticSubtitles}</p>
        <h2 id="generation-heading">{messages.generateSubtitles}</h2>
        <p>{messages.generationDescription}</p>
        <p>{messages.modelSetupNotice}</p>
        {readiness ? (
          <details>
            <summary>{messages.modelCache}</summary>
            <p style={{ overflowWrap: 'anywhere' }}>{readiness.cacheDir}</p>
          </details>
        ) : null}
      </div>
      <label>
        {messages.translateTo}
        <select
          value={targetLanguage}
          disabled={isGenerating}
          onChange={(event) => onTargetLanguageChange(event.currentTarget.value)}
        >
          <option value="">{messages.noTranslation}</option>
          {languageOptions.map((code) => (
            <option key={code} value={code}>{formatLanguageName(locale, code)}</option>
          ))}
        </select>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={diarize}
          disabled={isGenerating || !readiness?.diarizationAvailable}
          aria-describedby="speaker-availability"
          onChange={(event) => onDiarizeChange(event.currentTarget.checked)}
        />
        {messages.identifySpeakers}
      </label>
      {!readiness?.diarizationAvailable ? (
        <p id="speaker-availability">{messages.speakerUnavailable}</p>
      ) : null}
      <button className="generate-button" type="button" disabled={isGenerating} onClick={onGenerate}>
        {isGenerating ? messages.generationRunning : messages.generateSubtitles}
      </button>
      {generationMessage || readinessError ? (
        <p className="generation-status" role="status">{generationMessage || readinessError}</p>
      ) : null}
    </section>
  )
}
