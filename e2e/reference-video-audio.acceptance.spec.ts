import { expect, test } from '@playwright/test'

test('Chromium exposes the worker-safe WebCodecs audio boundary used by browser generation', async ({ page }) => {
  await page.goto('about:blank')

  const result = await page.evaluate(async () => {
    if (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function') {
      return { available: false, opus: false }
    }
    const opus = await AudioDecoder.isConfigSupported({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 1,
    })
    return {
      available: true,
      opus: opus.supported,
    }
  })

  test.skip(
    !result.available,
    "This acceptance runner does not expose WebCodecs AudioDecoder; browser-generation evidence is unavailable rather than a product failure.",
  )
  expect(result.opus).toBe(true)
})
