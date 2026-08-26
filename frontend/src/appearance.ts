export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]
export type ResolvedAppearance = Exclude<Appearance, 'system'>

const storageKey = 'subtitle-merger.appearance'
const darkMediaQuery = '(prefers-color-scheme: dark)'

export function normalizeAppearance(value?: string | null): Appearance {
  return appearances.includes(value as Appearance) ? (value as Appearance) : 'system'
}

export function getPreferredAppearance(): Appearance {
  if (typeof window === 'undefined') return 'system'
  return normalizeAppearance(window.localStorage.getItem(storageKey))
}

export function resolveAppearance(
  appearance: Appearance,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  if (appearance === 'system') return systemPrefersDark ? 'dark' : 'light'
  return appearance
}

export function applyAppearance(appearance: Appearance): () => void {
  if (typeof window === 'undefined') return () => undefined

  const media = window.matchMedia(darkMediaQuery)
  const apply = () => {
    const resolved = resolveAppearance(appearance, media.matches)
    window.document.documentElement.dataset['theme'] = resolved
    window.document.documentElement.style.colorScheme = resolved
    window.document.documentElement.classList.toggle('dark', resolved === 'dark')
  }

  window.localStorage.setItem(storageKey, appearance)
  apply()

  if (appearance !== 'system') return () => undefined

  media.addEventListener('change', apply)
  return () => media.removeEventListener('change', apply)
}
