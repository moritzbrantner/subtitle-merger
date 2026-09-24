import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(new URL('./fixtures/acceptance-video.webm', import.meta.url))

const browserRuntime = `
globalThis.__subtitleMergerBrowserTranscription = {
  browserTranscriptionCapabilities() {
    return {
      runtime: "acceptance-webgpu",
      requiredAcceleration: "webgpu",
      modelId: "acceptance-whisper",
      modelProvisioning: "acceptance-fixture",
      features: {
        transcription: true,
        timedSegments: true,
        boundedPcmStreaming: true,
        mediaStreamAdapter: true,
      },
      fallbacks: {
        server: false,
        python: false,
        cpu: false,
      },
    };
  },
  async supportsBrowserTranscription() {
    return true;
  },
  async transcribeAudioBlob() {
    globalThis.__subtitleMergerGenerationEvidence = {
      ...(globalThis.__subtitleMergerGenerationEvidence ?? {}),
      blobPathUsed: true,
    };
    throw new DOMException(
      "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
      "NotReadableError",
    );
  },
  async createBrowserMediaStreamTranscriptionSession(stream, options = {}) {
    const audioTracks = stream.getAudioTracks();
    globalThis.__subtitleMergerGenerationEvidence = {
      ...(globalThis.__subtitleMergerGenerationEvidence ?? {}),
      streamPathUsed: true,
      audioTrackCount: audioTracks.length,
    };
    options.onProgress?.({
      stage: "capture",
      message: "Capturing bounded browser audio…",
    });
    return {
      async finish() {
        return {
          text: "Generated from bounded media",
          language: "en",
          segments: [
            {
              index: 0,
              startSeconds: 0.1,
              endSeconds: 1.2,
              text: "Generated from bounded media",
            },
          ],
          source: "acceptance-video.webm",
          attributes: {
            runtime: "acceptance-webgpu",
          },
        };
      },
      async abort() {},
    };
  },
};
`

const inspectionWorker = `
self.onmessage = () => {
  self.postMessage({
    type: "result",
    inspection: {
      container: "webm",
      durationMs: 2000,
      tracks: [],
      unsupported: [],
      warnings: [],
    },
  });
};
`

async function prepareBrowserRuntime(page: import('@playwright/test').Page) {
  await page.route('**/browser-transcription-bridge.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: browserRuntime,
    }),
  )
  await page.route('**/video-inspection-worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: inspectionWorker,
    }),
  )
}

test('keeps the selected Reference Video attached to its file input', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(fixturePath)

  await expect.poll(() => input.evaluate((element) => {
    const fileInput = element as HTMLInputElement
    return fileInput.files?.length ?? 0
  })).toBe(1)
  await expect(page.getByRole('button', { name: /Generate subtitles/ })).toBeEnabled()
})

test('falls back to a bounded browser media stream when whole-video reading fails', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(fixturePath)
  const generate = page.getByRole('button', { name: /Generate subtitles/ })
  await expect(generate).toBeEnabled()
  await generate.click()

  await expect(page.getByRole('heading', { name: 'Generated' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Generated from bounded media').last()).toBeVisible()

  const evidence = await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __subtitleMergerGenerationEvidence?: {
        blobPathUsed?: boolean
        streamPathUsed?: boolean
        audioTrackCount?: number
      }
    }).__subtitleMergerGenerationEvidence,
  )
  expect(evidence).toEqual({
    streamPathUsed: true,
    audioTrackCount: 1,
  })

  if (process.env['CAPTURE_UI_SCREENSHOT'] === '1') {
    await mkdir('.artifacts', { recursive: true })
    await page.screenshot({
      path: '.artifacts/browser-generation-readability.png',
      fullPage: true,
    })
  }
})
