import { describe, expect, it } from 'vitest'
import { normalizeAppearance, resolveAppearance } from './appearance'

describe('appearance', () => {
  it('normalizes persisted preferences', () => {
    expect(normalizeAppearance('system')).toBe('system')
    expect(normalizeAppearance('light')).toBe('light')
    expect(normalizeAppearance('dark')).toBe('dark')
    expect(normalizeAppearance('unknown')).toBe('system')
  })

  it('resolves system appearance without overriding explicit choices', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('dark', false)).toBe('dark')
  })
})
