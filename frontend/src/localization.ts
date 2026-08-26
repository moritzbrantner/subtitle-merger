export const supportedLocales = ['en', 'de', 'es'] as const

export type Locale = (typeof supportedLocales)[number]

export type AppMessages = {
  appName: string
  title: string
  mainMenu: string
  file: string
  opening: string
  openVideo: string
  exportSubtitles: string
  language: string
  appearance: string
  appearanceSystem: string
  appearanceLight: string
  appearanceDark: string
  automaticSubtitles: string
  generateSubtitles: string
  generationDescription: string
  translateTo: string
  noTranslation: string
  identifySpeakers: string
  starting: string
  preparingGeneration: string
  generationRunning: string
  referenceVideo: string
  playbackBlocked: string
  referenceVideoFailed: string
  videoDurationFailed: string
  videoLoadFailed: string
  emptyTracks: string
  sourceTrack: string
  translationTrack: string
  timelineLabel: string
  exportEyebrow: string
  exportHeading: string
  closeExportDialog: string
  track: string
  format: string
  noEditableTracks: string
  cancel: string
  export: string
  chooseTrack: string
  exportFailed: string
  jobPhases: Record<
    | 'queued'
    | 'decoding'
    | 'detectingSpeech'
    | 'transcribing'
    | 'aligning'
    | 'diarizing'
    | 'translating'
    | 'writingOutput'
    | 'completed'
    | 'cancelled'
    | 'failed',
    string
  >
}

const messages: Record<Locale, AppMessages> = {
  en: {
    appName: 'Subtitle Merger',
    title: 'Subtitle Timeline Editor',
    mainMenu: 'Main menu',
    file: 'File',
    opening: 'Opening…',
    openVideo: 'Open video…',
    exportSubtitles: 'Export subtitles…',
    language: 'Language',
    appearance: 'Appearance',
    appearanceSystem: 'System',
    appearanceLight: 'Light',
    appearanceDark: 'Dark',
    automaticSubtitles: 'Automatic subtitles',
    generateSubtitles: 'Generate subtitles',
    generationDescription: 'Creates an editable source track and optional translated track.',
    translateTo: 'Translate to',
    noTranslation: 'No translation',
    identifySpeakers: 'Identify speakers',
    starting: 'Starting…',
    preparingGeneration: 'Preparing subtitle generation…',
    generationRunning: 'Subtitle generation is running…',
    referenceVideo: 'Reference video',
    playbackBlocked: 'Video playback was blocked. Interact with the timeline and try again.',
    referenceVideoFailed: 'Could not play the reference video.',
    videoDurationFailed: 'Could not read video duration.',
    videoLoadFailed: 'Could not load this video.',
    emptyTracks: 'No subtitle tracks yet. Generate subtitles to add editable tracks.',
    sourceTrack: 'Subtitles',
    translationTrack: 'Translation',
    timelineLabel: 'Subtitle timeline editor',
    exportEyebrow: 'Export subtitles',
    exportHeading: 'Save the current edited track',
    closeExportDialog: 'Close export dialog',
    track: 'Track',
    format: 'Format',
    noEditableTracks: 'No editable subtitle tracks are available yet. Load or generate subtitles first.',
    cancel: 'Cancel',
    export: 'Export',
    chooseTrack: 'Choose an editable subtitle track to export.',
    exportFailed: 'Could not export subtitles.',
    jobPhases: {
      queued: 'Queued',
      decoding: 'Decoding media',
      detectingSpeech: 'Detecting speech',
      transcribing: 'Transcribing',
      aligning: 'Aligning',
      diarizing: 'Identifying speakers',
      translating: 'Translating',
      writingOutput: 'Writing output',
      completed: 'Completed',
      cancelled: 'Cancelled',
      failed: 'Failed',
    },
  },
  de: {
    appName: 'Subtitle Merger',
    title: 'Untertitel-Zeitleisteneditor',
    mainMenu: 'Hauptmenü',
    file: 'Datei',
    opening: 'Wird geöffnet…',
    openVideo: 'Video öffnen…',
    exportSubtitles: 'Untertitel exportieren…',
    language: 'Sprache',
    appearance: 'Darstellung',
    appearanceSystem: 'System',
    appearanceLight: 'Hell',
    appearanceDark: 'Dunkel',
    automaticSubtitles: 'Automatische Untertitel',
    generateSubtitles: 'Untertitel erzeugen',
    generationDescription: 'Erstellt eine bearbeitbare Quellspur und optional eine übersetzte Spur.',
    translateTo: 'Übersetzen nach',
    noTranslation: 'Keine Übersetzung',
    identifySpeakers: 'Sprecher erkennen',
    starting: 'Wird gestartet…',
    preparingGeneration: 'Untertitelerzeugung wird vorbereitet…',
    generationRunning: 'Untertitelerzeugung läuft…',
    referenceVideo: 'Referenzvideo',
    playbackBlocked: 'Die Videowiedergabe wurde blockiert. Interagiere mit der Zeitleiste und versuche es erneut.',
    referenceVideoFailed: 'Das Referenzvideo konnte nicht wiedergegeben werden.',
    videoDurationFailed: 'Die Videodauer konnte nicht gelesen werden.',
    videoLoadFailed: 'Dieses Video konnte nicht geladen werden.',
    emptyTracks: 'Noch keine Untertitelspuren. Erzeuge Untertitel, um bearbeitbare Spuren hinzuzufügen.',
    sourceTrack: 'Untertitel',
    translationTrack: 'Übersetzung',
    timelineLabel: 'Untertitel-Zeitleisteneditor',
    exportEyebrow: 'Untertitel exportieren',
    exportHeading: 'Aktuell bearbeitete Spur speichern',
    closeExportDialog: 'Exportdialog schließen',
    track: 'Spur',
    format: 'Format',
    noEditableTracks: 'Es sind noch keine bearbeitbaren Untertitelspuren verfügbar. Lade oder erzeuge zuerst Untertitel.',
    cancel: 'Abbrechen',
    export: 'Exportieren',
    chooseTrack: 'Wähle eine bearbeitbare Untertitelspur zum Exportieren.',
    exportFailed: 'Untertitel konnten nicht exportiert werden.',
    jobPhases: {
      queued: 'Eingereiht',
      decoding: 'Medien werden dekodiert',
      detectingSpeech: 'Sprache wird erkannt',
      transcribing: 'Transkription läuft',
      aligning: 'Ausrichtung läuft',
      diarizing: 'Sprecher werden erkannt',
      translating: 'Übersetzung läuft',
      writingOutput: 'Ausgabe wird geschrieben',
      completed: 'Abgeschlossen',
      cancelled: 'Abgebrochen',
      failed: 'Fehlgeschlagen',
    },
  },
  es: {
    appName: 'Subtitle Merger',
    title: 'Editor de línea de tiempo de subtítulos',
    mainMenu: 'Menú principal',
    file: 'Archivo',
    opening: 'Abriendo…',
    openVideo: 'Abrir vídeo…',
    exportSubtitles: 'Exportar subtítulos…',
    language: 'Idioma',
    appearance: 'Apariencia',
    appearanceSystem: 'Sistema',
    appearanceLight: 'Claro',
    appearanceDark: 'Oscuro',
    automaticSubtitles: 'Subtítulos automáticos',
    generateSubtitles: 'Generar subtítulos',
    generationDescription: 'Crea una pista fuente editable y una pista traducida opcional.',
    translateTo: 'Traducir a',
    noTranslation: 'Sin traducción',
    identifySpeakers: 'Identificar hablantes',
    starting: 'Iniciando…',
    preparingGeneration: 'Preparando la generación de subtítulos…',
    generationRunning: 'La generación de subtítulos está en curso…',
    referenceVideo: 'Vídeo de referencia',
    playbackBlocked: 'La reproducción del vídeo fue bloqueada. Interactúa con la línea de tiempo e inténtalo de nuevo.',
    referenceVideoFailed: 'No se pudo reproducir el vídeo de referencia.',
    videoDurationFailed: 'No se pudo leer la duración del vídeo.',
    videoLoadFailed: 'No se pudo cargar este vídeo.',
    emptyTracks: 'Aún no hay pistas de subtítulos. Genera subtítulos para añadir pistas editables.',
    sourceTrack: 'Subtítulos',
    translationTrack: 'Traducción',
    timelineLabel: 'Editor de línea de tiempo de subtítulos',
    exportEyebrow: 'Exportar subtítulos',
    exportHeading: 'Guardar la pista editada actual',
    closeExportDialog: 'Cerrar diálogo de exportación',
    track: 'Pista',
    format: 'Formato',
    noEditableTracks: 'Aún no hay pistas de subtítulos editables. Carga o genera subtítulos primero.',
    cancel: 'Cancelar',
    export: 'Exportar',
    chooseTrack: 'Elige una pista de subtítulos editable para exportar.',
    exportFailed: 'No se pudieron exportar los subtítulos.',
    jobPhases: {
      queued: 'En cola',
      decoding: 'Decodificando medios',
      detectingSpeech: 'Detectando voz',
      transcribing: 'Transcribiendo',
      aligning: 'Alineando',
      diarizing: 'Identificando hablantes',
      translating: 'Traduciendo',
      writingOutput: 'Escribiendo salida',
      completed: 'Completado',
      cancelled: 'Cancelado',
      failed: 'Fallido',
    },
  },
}

export function normalizeLocale(value?: string | null): Locale {
  const candidate = value?.toLowerCase().split('-')[0]
  return supportedLocales.includes(candidate as Locale) ? (candidate as Locale) : 'en'
}

export function getPreferredLocale(): Locale {
  if (typeof window === 'undefined') return 'en'

  const stored = window.localStorage.getItem('subtitle-merger.locale')
  if (stored) return normalizeLocale(stored)

  return normalizeLocale(window.navigator.languages?.[0] ?? window.navigator.language)
}

export function persistLocale(locale: Locale): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('subtitle-merger.locale', locale)
  window.document.documentElement.lang = locale
}

export function getMessages(locale: Locale): AppMessages {
  return messages[locale]
}

export function formatLanguageName(locale: Locale, languageCode: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(languageCode) ?? languageCode
  } catch {
    return languageCode
  }
}
