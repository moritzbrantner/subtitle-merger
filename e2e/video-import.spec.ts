import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { loadVideoByPath, openVideoPathDialog } from './video-path'

const fixtureFilename = 'acceptance-video.webm'
const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFilename}`, import.meta.url))

const loadedVideo = {
  loadId: 'load-1',
  video: {
    id: 'video-1',
    filename: fixtureFilename,
    stem: 'acceptance-video',
    mediaUrl: '/api/test-video',
    mimeType: 'video/webm',
  },
  subtitles: [],
  warnings: [],
}

test('opens, validates, and cancels the absolute-path dialog from the keyboard', async ({ page }) => {
  await page.goto('/')

  const fileButton = page.getByRole('button', { name: 'File', exact: true })
  let dialog = await openVideoPathDialog(page)
  const pathInput = dialog.getByRole('textbox', { name: 'Absolute video path' })

  await expect(pathInput).toBeFocused()
  await pathInput.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(fileButton).toBeFocused()

  dialog = await openVideoPathDialog(page)
  await dialog.getByRole('button', { name: 'Load video' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Enter an absolute video path.')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(fileButton).toBeFocused()
})

test('loads a Reference Video by absolute path with an observable loading state', async ({ page }) => {
  let releaseLoad: (() => void) | undefined
  const pendingLoad = new Promise<void>((resolve) => {
    releaseLoad = resolve
  })

  await page.route('**/api/video-loads', async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ path: fixturePath })
    await pendingLoad
    await route.fulfill({ contentType: 'application/json', json: loadedVideo })
  })
  await page.route('**/api/test-video', async (route) => {
    await route.fulfill({ contentType: 'video/webm', path: fixturePath })
  })
  await page.goto('/')

  const dialog = await openVideoPathDialog(page)
  await dialog.getByRole('textbox', { name: 'Absolute video path' }).fill(fixturePath)
  const loadButton = dialog.getByRole('button', { name: 'Load video' })
  await loadButton.click()

  await expect(dialog.getByRole('button', { name: 'Opening…' })).toBeDisabled()
  releaseLoad?.()

  await expect(dialog).toHaveCount(0)
  const timelineCanvas = page.locator("[data-slot='timeline-workbench-canvas']")
  await expect(page.getByTestId('reference-video')).toBeVisible()
  await expect(page.getByRole('heading', { name: fixtureFilename })).toBeVisible()
  await expect(timelineCanvas.getByRole('button', { name: fixtureFilename, exact: true })).toHaveCount(0)
  await expect(page.locator("[data-slot='timeline-workbench-assets']")).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('No subtitle tracks yet')
})

test('keeps the previous subtitle session when a later path load fails', async ({ page }) => {
  const firstPath = '/fixtures/working-video.webm'
  const missingPath = '/fixtures/missing-video.webm'

  await page.route('**/api/video-loads', async (route) => {
    const request = route.request().postDataJSON() as { path: string }

    if (request.path === missingPath) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        json: { error: 'Video path does not exist.' },
      })
      return
    }

    expect(request).toEqual({ path: firstPath })
    await route.fulfill({
      contentType: 'application/json',
      json: {
        ...loadedVideo,
        subtitles: [
          {
            id: 'subtitle-1',
            filename: 'working-video.en.srt',
            infixTitle: 'English',
            mediaUrl: '/api/test-subtitle-media',
            textUrl: '/api/test-subtitle-text',
            format: 'srt',
            mimeType: 'application/x-subrip',
          },
        ],
      },
    })
  })
  await page.route('**/api/test-video', async (route) => {
    await route.fulfill({ contentType: 'video/webm', path: fixturePath })
  })
  await page.route('**/api/test-subtitle-text', async (route) => {
    await route.fulfill({
      contentType: 'application/x-subrip',
      body: '1\n00:00:01,000 --> 00:00:03,000\nOgres are like onions.\n',
    })
  })

  await page.goto('/')
  await loadVideoByPath(page, firstPath)

  const englishTrack = page
    .locator("[data-slot='timeline-workbench-canvas']")
    .locator("[data-slot='timeline-editor-track-header'][aria-label='English']")
  await expect(page.getByRole('heading', { name: fixtureFilename })).toBeVisible()
  await expect(englishTrack).toBeVisible()

  const dialog = await openVideoPathDialog(page)
  await dialog.getByRole('textbox', { name: 'Absolute video path' }).fill(missingPath)
  await dialog.getByRole('button', { name: 'Load video' }).click()

  await expect(dialog.getByRole('alert')).toHaveText('Video path does not exist.')
  await expect(page.getByRole('heading', { name: fixtureFilename })).toBeVisible()
  await expect(englishTrack).toBeVisible()
})
