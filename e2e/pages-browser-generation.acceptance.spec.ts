import { expect, test } from '@playwright/test'
import { mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(new URL('./fixtures/acceptance-video.webm', import.meta.url))

const browserRuntime = `
globalThis.__subtitleMergerBrowserTranscription = {
  browserTranscriptionCapabilities() {
    return {
      runtime: "acceptance-webgpu",
      requiredAcceleration: "webgpu",
      modelId: "onnx-community/whisper-tiny",
      modelProvisioning: "acceptance-fixture",
      features: {
        transcription: true,
        timedSegments: true,
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
  async transcribeAudioBlob(source, options = {}) {
    globalThis.__subtitleMergerGenerationEvidence = {
      ...(globalThis.__subtitleMergerGenerationEvidence ?? {}),
      blobPathUsed: true,
      sourceSize: source.size,
    };
    options.onProgress?.({
      stage: "model",
      message: "Loading Whisper Tiny in the browser…",
    });
    if (globalThis.__subtitleMergerForceBlobReadFailure === true) {
      throw new DOMException(
        "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
        "NotReadableError",
      );
    }
    return {
      text: "Generated from finite local file",
      language: "en",
      segments: [
        {
          index: 0,
          startSeconds: 0.1,
          endSeconds: 1.2,
          text: "Generated from finite local file",
        },
      ],
      source: "acceptance-video.webm",
      attributes: {
        runtime: "acceptance-webgpu",
        modelId: "onnx-community/whisper-tiny",
      },
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

test('transcribes the selected Reference Video as one finite local file', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(fixturePath)
  const generate = page.getByRole('button', { name: /Generate subtitles/ })
  await expect(generate).toBeEnabled()
  await generate.click()

  await expect(page.getByRole('heading', { name: 'Generated' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Generated from finite local file').last()).toBeVisible()

  const evidence = await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __subtitleMergerGenerationEvidence?: {
        blobPathUsed?: boolean
        sourceSize?: number
      }
    }).__subtitleMergerGenerationEvidence,
  )
  expect(evidence).toEqual({
    blobPathUsed: true,
    sourceSize: (await stat(fixturePath)).size,
  })

  if (process.env['CAPTURE_UI_SCREENSHOT'] === '1') {
    await mkdir('.artifacts', { recursive: true })
    await page.screenshot({
      path: '.artifacts/browser-generation-readability.png',
      fullPage: true,
    })
  }
})

test('surfaces a finite-file read failure instead of switching to streaming', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as typeof globalThis & {
      __subtitleMergerForceBlobReadFailure?: boolean
    }).__subtitleMergerForceBlobReadFailure = true
  })
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(fixturePath)
  const generate = page.getByRole('button', { name: /Generate subtitles/ })
  await expect(generate).toBeEnabled()
  await generate.click()

  await expect(
    page.getByText(
      'The browser could not read the selected Reference Video for local Whisper transcription. Re-select the Reference Video and retry.',
    ),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Generated' })).toHaveCount(0)

  const evidence = await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __subtitleMergerGenerationEvidence?: {
        blobPathUsed?: boolean
        sourceSize?: number
      }
    }).__subtitleMergerGenerationEvidence,
  )
  expect(evidence).toEqual({
    blobPathUsed: true,
    sourceSize: (await stat(fixturePath)).size,
  })
})
