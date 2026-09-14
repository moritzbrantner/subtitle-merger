import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

const fixturePath = fileURLToPath(new URL('./fixtures/acceptance-video.webm', import.meta.url))

test('Chromium decodes the deterministic reference-video audio track', async ({ page }) => {
  const encoded = readFileSync(fixturePath).toString('base64')

  await page.goto('about:blank')
  const result = await page.evaluate(async (base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    const context = new AudioContext()
    try {
      const buffer = await context.decodeAudioData(bytes.buffer)
      let peak = 0
      for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
        const channel = buffer.getChannelData(channelIndex)
        for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
          peak = Math.max(peak, Math.abs(channel[sampleIndex] ?? 0))
        }
      }

      return {
        channels: buffer.numberOfChannels,
        durationSeconds: buffer.duration,
        decodedSampleRate: buffer.sampleRate,
        contextSampleRate: context.sampleRate,
        peak,
      }
    } finally {
      await context.close()
    }
  }, encoded)

  expect(result.channels).toBeGreaterThanOrEqual(1)
  expect(result.decodedSampleRate).toBe(result.contextSampleRate)
  expect(result.decodedSampleRate).toBeGreaterThanOrEqual(8_000)
  expect(result.durationSeconds).toBeGreaterThan(1.9)
  expect(result.durationSeconds).toBeLessThan(2.1)
  expect(result.peak).toBeGreaterThan(0.01)
})
