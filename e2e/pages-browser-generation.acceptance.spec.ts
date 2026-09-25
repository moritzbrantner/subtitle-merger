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
      models: [
        {
          id: "onnx-community/whisper-tiny",
          label: "Whisper Tiny",
          description: "Fastest and lowest-memory browser option.",
        },
        {
          id: "onnx-community/whisper-base",
          label: "Whisper Base",
          description: "Balanced browser accuracy and resource use.",
        },
        {
          id: "onnx-community/whisper-small",
          label: "Whisper Small",
          description: "Higher accuracy with a much larger download and memory footprint.",
        },
      ],
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
  browserTranscriptionModels() {
    return this.browserTranscriptionCapabilities().models;
  },
  async supportsBrowserTranscription() {
    return true;
  },
  async transcribeAudioBlob(source, options = {}) {
    globalThis.__subtitleMergerGenerationEvidence = {
      ...(globalThis.__subtitleMergerGenerationEvidence ?? {}),
      blobPathUsed: true,
      sourceSize: source.size,
      selectedModelId: options.modelId,
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
    if (globalThis.__subtitleMergerForceAllocationFailure === true) {
      throw new Error("ArrayBuffer allocation failed while decoding the Reference Video.");
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
        modelId: options.modelId,
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
  const modelSelect = page.getByRole('combobox', { name: 'Whisper model' })
  await expect(modelSelect).toHaveValue('onnx-community/whisper-tiny')
  await expect(modelSelect.locator('option')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /Generate subtitles/ })).toBeEnabled()
})

test('transcribes the selected Reference Video as one finite local file', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(fixturePath)
  const modelSelect = page.getByRole('combobox', { name: 'Whisper model' })
  await modelSelect.selectOption('onnx-community/whisper-base')
  await expect(page.getByText('Balanced browser accuracy and resource use.')).toBeVisible()

  const generate = page.getByRole('button', { name: /Generate subtitles/ })
  await expect(generate).toContainText('Generate with Whisper Base')
  await expect(generate).toBeEnabled()
  await generate.click()

  await expect(page.getByRole('heading', { name: 'Generated' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Generated from finite local file').last()).toBeVisible()

  const evidence = await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __subtitleMergerGenerationEvidence?: {
        blobPathUsed?: boolean
        sourceSize?: number
        selectedModelId?: string
      }
    }).__subtitleMergerGenerationEvidence,
  )
  expect(evidence).toEqual({
    blobPathUsed: true,
    sourceSize: (await stat(fixturePath)).size,
    selectedModelId: 'onnx-community/whisper-base',
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
        selectedModelId?: string
      }
    }).__subtitleMergerGenerationEvidence,
  )
  expect(evidence).toEqual({
    blobPathUsed: true,
    sourceSize: (await stat(fixturePath)).size,
    selectedModelId: 'onnx-community/whisper-tiny',
  })
})

test('preserves finite-file allocation failures instead of calling them stale file handles', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as typeof globalThis & {
      __subtitleMergerForceAllocationFailure?: boolean
    }).__subtitleMergerForceAllocationFailure = true
  })
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(fixturePath)
  const generate = page.getByRole('button', { name: /Generate subtitles/ })
  await expect(generate).toBeEnabled()
  await generate.click()

  await expect(
    page.getByText('ArrayBuffer allocation failed while decoding the Reference Video.'),
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText(/Re-select the Reference Video and retry/),
  ).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Generated' })).toHaveCount(0)
})
