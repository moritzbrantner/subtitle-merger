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
  messages,
  locale,
  targetLanguage,
  diarize,
  isGenerating,
  generationMessage,
  onTargetLanguageChange,
  onDiarizeChange,
  onGenerate,
}: GenerationPanelProps) {
  return (
    <section className="generation-panel" aria-labelledby="generation-heading">
      <div>
        <p className="eyebrow">{messages.automaticSubtitles}</p>
        <h2 id="generation-heading">{messages.generateSubtitles}</h2>
        <p>{messages.generationDescription}</p>
      </div>
      <label>
        {messages.translateTo}
        <select
          value={targetLanguage}
          onChange={(event) => onTargetLanguageChange(event.currentTarget.value)}
        >
          <option value="">{messages.noTranslation}</option>
          {languageOptions.map((code) => (
            <option key={code} value={code}>
              {formatLanguageName(locale, code)}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={diarize}
          onChange={(event) => onDiarizeChange(event.currentTarget.checked)}
        />
        {messages.identifySpeakers}
      </label>
      <button
        className="generate-button"
        type="button"
        disabled={isGenerating}
        onClick={onGenerate}
      >
        {isGenerating ? messages.starting : messages.generateSubtitles}
      </button>
      {generationMessage ? (
        <p className="generation-status" role="status">
          {generationMessage}
        </p>
      ) : null}
    </section>
  )
}
