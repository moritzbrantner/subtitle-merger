import { expect, test } from '@playwright/test'
import { mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(new URL('./fixtures/acceptance-video.webm', import.meta.url))
const englishSubtitleFixturePath = fileURLToPath(new URL('./fixtures/pages-editor.en.srt', import.meta.url))
const germanSubtitleFixturePath = fileURLToPath(new URL('./fixtures/pages-editor.de.srt', import.meta.url))

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


test('edits subtitles directly in the video and scrubs the attached translation timeline', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const fileInputs = page.locator('input[type="file"]')
  await fileInputs.nth(0).setInputFiles(fixturePath)
  await fileInputs.nth(1).setInputFiles([
    englishSubtitleFixturePath,
    germanSubtitleFixturePath,
  ])

  const editorStack = page.locator('.video-editor-stack')
  const timeline = editorStack.getByTestId('subtitle-timeline')
  await expect(timeline).toBeVisible()
  await expect(timeline.getByTestId('subtitle-timeline-lane')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Inspect' })).toHaveCount(0)

  const cue = page
    .getByTestId('video-subtitle-cue')
    .filter({ hasText: 'Editable source subtitle' })
  await expect(cue).toBeVisible()
  const cueButton = cue.getByRole('button')
  await cueButton.click()
  await expect(cue).toHaveAttribute('data-selected', 'true')
  await expect(page.getByLabel('Selected subtitle controls')).toBeVisible()

  const beforeX = Number(await cue.getAttribute('data-position-x'))
  const beforeY = Number(await cue.getAttribute('data-position-y'))
  const cueBounds = await cueButton.boundingBox()
  expect(cueBounds).not.toBeNull()
  await page.mouse.move(
    cueBounds!.x + cueBounds!.width / 2,
    cueBounds!.y + cueBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    cueBounds!.x + cueBounds!.width / 2 + 80,
    cueBounds!.y + cueBounds!.height / 2 - 50,
  )
  await page.mouse.up()

  await expect.poll(async () => Number(await cue.getAttribute('data-position-x'))).not.toBe(beforeX)
  await expect.poll(async () => Number(await cue.getAttribute('data-position-y'))).not.toBe(beforeY)

  await cue.getByRole('button').dblclick()
  const textEditor = page.getByRole('textbox', { name: /Edit pages-editor\.en, cue 1/ })
  await expect(textEditor).toBeVisible()
  await textEditor.fill('Edited directly on video')
  await textEditor.press('Control+Enter')
  await expect(cue).toContainText('Edited directly on video')

  const scrubber = page.getByTestId('timeline-scrubber')
  const scrubberBounds = await scrubber.boundingBox()
  expect(scrubberBounds).not.toBeNull()
  await page.mouse.click(
    scrubberBounds!.x + scrubberBounds!.width * 0.55,
    scrubberBounds!.y + scrubberBounds!.height / 2,
  )
  await expect.poll(async () => Number(await scrubber.getAttribute('aria-valuenow'))).toBeGreaterThan(800)
  await expect.poll(async () =>
    page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentTime),
  ).toBeGreaterThan(0.8)
})
