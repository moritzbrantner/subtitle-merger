import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const webmFixturePath = fileURLToPath(new URL('./fixtures/acceptance-video.webm', import.meta.url))
const mp4FixturePath = fileURLToPath(new URL('./fixtures/acceptance-video.mp4', import.meta.url))
const englishSubtitleFixturePath = fileURLToPath(new URL('./fixtures/pages-editor.en.srt', import.meta.url))
const germanSubtitleFixturePath = fileURLToPath(new URL('./fixtures/pages-editor.de.srt', import.meta.url))

const browserRuntimeModule = `
const models = [
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
];

export function browserTranscriptionModels() {
  return models.map((model) => ({ ...model }));
}

export function browserTranscriptionCapabilities() {
  return {
    runtime: "acceptance-webgpu",
    requiredAcceleration: "webgpu",
    modelId: "onnx-community/whisper-tiny",
    models: browserTranscriptionModels(),
    modelProvisioning: "acceptance-fixture",
    modelLifecycle: {
      maxIdleResidentModels: 1,
      eviction: "dispose-superseded",
    },
    features: {
      transcription: true,
      timedSegments: true,
      boundedPcmStreaming: true,
      decodedAudioAdapter: true,
      mediaStreamAdapter: true,
    },
    fallbacks: {
      server: false,
      python: false,
      cpu: false,
    },
  };
}

export async function supportsBrowserTranscription() {
  return true;
}

export async function transcribeAudioBlob() {
  throw new Error("Whole-file Blob transcription must not be used by Subtitle Merger.");
}

export function createBrowserDecodedAudioTranscriptionSession(options = {}) {
  let decodedFrames = 0;
  let decodedSamples = 0;
  let peak = 0;
  let sampleRate = 0;

  return {
    async push(audioData) {
      sampleRate ||= audioData.sampleRate;
      if (audioData.sampleRate !== sampleRate) {
        audioData.close();
        throw new Error("Decoded fixture sample rate changed unexpectedly.");
      }
      for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
        const plane = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
        for (const sample of plane) {
          peak = Math.max(peak, Math.abs(sample));
        }
      }
      decodedFrames += 1;
      decodedSamples += audioData.numberOfFrames;
      audioData.close();
      return [];
    },
    async flush() {
      if (decodedFrames === 0 || decodedSamples === 0 || peak <= 0.01) {
        throw new Error("WebCodecs did not produce non-silent decoded audio.");
      }
      const label = models.find((model) => model.id === options.modelId)?.label ?? options.modelId;
      const text = "Range decoded with " + label;
      return {
        text,
        language: "en",
        segments: [
          {
            index: 0,
            startSeconds: 0.1,
            endSeconds: 1.2,
            text,
          },
        ],
        source: options.source ?? "acceptance-video",
        attributes: {
          runtime: "acceptance-webgpu",
          modelId: options.modelId,
          decodedFrames: String(decodedFrames),
          decodedSamples: String(decodedSamples),
          peak: String(peak),
        },
      };
    },
    get bufferedSeconds() {
      return 0;
    },
  };
}
`

const browserBridge = `
import * as runtime from "./vendor/audio-analysis-transcription.js";
globalThis.__subtitleMergerBrowserTranscription = runtime;
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
  await page.route('**/vendor/audio-analysis-transcription.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: browserRuntimeModule,
    }),
  )
  await page.route('**/browser-transcription-bridge.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: browserBridge,
    }),
  )
  await page.route('**/video-inspection-worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: inspectionWorker,
    }),
  )
}

async function chooseVideo(page: import('@playwright/test').Page, fixturePath: string) {
  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(webmFixturePath)
  await expect.poll(() => input.evaluate((element) => {
    const fileInput = element as HTMLInputElement
    return fileInput.files?.length ?? 0
  })).toBe(1)
  return input
}

test('keeps the selected Reference Video attached and exposes reviewed Whisper models', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  await chooseVideo(page, webmFixturePath)

  const modelSelect = page.getByRole('combobox', { name: 'Whisper model' })
  await expect(modelSelect).toHaveValue('onnx-community/whisper-tiny')
  await expect(modelSelect.locator('option')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /Generate subtitles/ })).toBeEnabled()
})

test('range-demuxes WebM Opus through WASM and WebCodecs before transcription', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  await chooseVideo(page, webmFixturePath)
  const modelSelect = page.getByRole('combobox', { name: 'Whisper model' })
  await modelSelect.selectOption('onnx-community/whisper-base')
  await expect(page.getByText('Balanced browser accuracy and resource use.')).toBeVisible()

  const generate = page.getByRole('button', { name: /Generate subtitles/ })
  await expect(generate).toContainText('Generate with Whisper Base')
  await generate.click()

  await expect(page.getByRole('heading', { name: 'Generated' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Range decoded with Whisper Base').last()).toBeVisible()

  if (process.env['CAPTURE_UI_SCREENSHOT'] === '1') {
    await mkdir('.artifacts', { recursive: true })
    await page.screenshot({
      path: '.artifacts/browser-generation-readability.png',
      fullPage: true,
    })
  }
})

test('range-demuxes MP4 AAC through WASM and WebCodecs before transcription', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  await chooseVideo(page, mp4FixturePath)
  const modelSelect = page.getByRole('combobox', { name: 'Whisper model' })
  await modelSelect.selectOption('onnx-community/whisper-small')

  const generate = page.getByRole('button', { name: /Generate subtitles/ })
  await expect(generate).toContainText('Generate with Whisper Small')
  await generate.click()

  await expect(page.getByRole('heading', { name: 'Generated' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Range decoded with Whisper Small').last()).toBeVisible()
})

test('browser generation does not depend on the upstream whole-Blob transcription entrypoint', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  await chooseVideo(page, webmFixturePath)
  await page.getByRole('button', { name: /Generate subtitles/ }).click()

  await expect(page.getByText('Range decoded with Whisper Tiny').last()).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText(/Whole-file Blob transcription must not be used/)).toHaveCount(0)
})


test('edits subtitles directly in the video and scrubs the attached translation timeline', async ({ page }) => {
  await prepareBrowserRuntime(page)
  await page.goto('/')

  const fileInputs = page.locator('input[type="file"]')
  await fileInputs.nth(0).setInputFiles(webmFixturePath)
  await fileInputs.nth(1).setInputFiles([
    englishSubtitleFixturePath,
    germanSubtitleFixturePath,
  ])

  const editorStack = page.locator('.video-editor-stack')
  const timeline = editorStack.getByTestId('subtitle-timeline')
  await expect(timeline).toBeVisible()
  await expect(timeline.getByTestId('subtitle-timeline-lane')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Inspect', exact: true })).toHaveCount(0)

  const initialCue = page
    .getByTestId('video-subtitle-cue')
    .filter({ hasText: 'Editable source subtitle' })
  await expect(initialCue).toBeVisible()
  // Re-locate by identity rather than text so the cue stays addressable after its text is edited.
  const cueTrackId = await initialCue.getAttribute('data-track-id')
  const cueIndex = await initialCue.getAttribute('data-cue-index')
  const cue = page.locator(
    `[data-testid="video-subtitle-cue"][data-track-id="${cueTrackId}"][data-cue-index="${cueIndex}"]`,
  )
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

  const scrubber = page.getByTestId('timeline-scrubber')
  const scrubberBounds = await scrubber.boundingBox()
  expect(scrubberBounds).not.toBeNull()
  await page.mouse.click(
    scrubberBounds!.x + scrubberBounds!.width * 0.95,
    scrubberBounds!.y + scrubberBounds!.height / 2,
  )
  await expect.poll(async () => Number(await scrubber.getAttribute('aria-valuenow'))).toBeGreaterThan(1_800)
  await expect(textEditor).toBeVisible()

  await page.mouse.click(
    scrubberBounds!.x + scrubberBounds!.width * 0.55,
    scrubberBounds!.y + scrubberBounds!.height / 2,
  )
  await expect.poll(async () => Number(await scrubber.getAttribute('aria-valuenow'))).toBeGreaterThan(800)
  await expect(textEditor).toBeVisible()

  await textEditor.fill('Edited directly on video')
  await textEditor.press('Control+Enter')
  await expect(cue).toContainText('Edited directly on video')
  await expect.poll(async () =>
    page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentTime),
  ).toBeGreaterThan(0.8)

  if (process.env['CAPTURE_UI_SCREENSHOT'] === '1') {
    await mkdir('.artifacts', { recursive: true })
    await page.screenshot({
      path: '.artifacts/direct-subtitle-editor.png',
      fullPage: true,
    })
  }
})
