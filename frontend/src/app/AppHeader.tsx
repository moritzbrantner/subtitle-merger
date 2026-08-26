import { useState } from 'react'
import { appearances, type Appearance } from '../appearance'
import {
  formatLanguageName,
  supportedLocales,
  type AppMessages,
  type Locale,
} from '../localization'

type AppHeaderProps = {
  messages: AppMessages
  locale: Locale
  appearance: Appearance
  isPickingVideo: boolean
  onOpenVideo: () => void
  onOpenExport: () => void
  onLocaleChange: (locale: Locale) => void
  onAppearanceChange: (appearance: Appearance) => void
}

export function AppHeader({
  messages,
  locale,
  appearance,
  isPickingVideo,
  onOpenVideo,
  onOpenExport,
  onLocaleChange,
  onAppearanceChange,
}: AppHeaderProps) {
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false)

  return (
    <header className="editor-topbar">
      <div className="editor-title">
        <p className="eyebrow">{messages.appName}</p>
        <h1>{messages.title}</h1>
      </div>

      <nav className="menu-bar" aria-label={messages.mainMenu}>
        <button
          className="menu-trigger"
          type="button"
          aria-expanded={isFileMenuOpen}
          aria-controls="file-menu"
          aria-haspopup="menu"
          onClick={() => setIsFileMenuOpen((isOpen) => !isOpen)}
        >
          {messages.file}
        </button>
        {isFileMenuOpen ? (
          <div className="menu-items" id="file-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={isPickingVideo}
              onClick={() => {
                setIsFileMenuOpen(false)
                onOpenVideo()
              }}
            >
              {isPickingVideo ? messages.opening : messages.openVideo}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsFileMenuOpen(false)
                onOpenExport()
              }}
            >
              {messages.exportSubtitles}
            </button>
          </div>
        ) : null}
      </nav>

      <div className="editor-preferences">
        <label className="preference-select">
          <span>{messages.language}</span>
          <select
            value={locale}
            onChange={(event) => onLocaleChange(event.currentTarget.value as Locale)}
          >
            {supportedLocales.map((candidate) => (
              <option key={candidate} value={candidate}>
                {formatLanguageName(candidate, candidate)}
              </option>
            ))}
          </select>
        </label>
        <label className="preference-select">
          <span>{messages.appearance}</span>
          <select
            value={appearance}
            onChange={(event) => onAppearanceChange(event.currentTarget.value as Appearance)}
          >
            {appearances.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate === 'system'
                  ? messages.appearanceSystem
                  : candidate === 'light'
                    ? messages.appearanceLight
                    : messages.appearanceDark}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  )
}
