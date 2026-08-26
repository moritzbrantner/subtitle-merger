import { describe, expect, it } from 'vitest'
import { formatLanguageName, getMessages, normalizeLocale } from './localization'

describe('localization', () => {
  it('normalizes supported browser locales and falls back to English', () => {
    expect(normalizeLocale('de-DE')).toBe('de')
    expect(normalizeLocale('es-MX')).toBe('es')
    expect(normalizeLocale('fr-FR')).toBe('en')
  })

  it('provides complete localized application labels', () => {
    expect(getMessages('en').generateSubtitles).toBe('Generate subtitles')
    expect(getMessages('de').generateSubtitles).toBe('Untertitel erzeugen')
    expect(getMessages('es').generateSubtitles).toBe('Generar subtítulos')
    expect(getMessages('de').jobPhases.detectingSpeech).toBeTruthy()
  })

  it('uses the active locale for language names', () => {
    expect(formatLanguageName('de', 'es').toLocaleLowerCase('de')).toContain('span')
    expect(formatLanguageName('es', 'de').toLocaleLowerCase('es')).toContain('alem')
  })
})
