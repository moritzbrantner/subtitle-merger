import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { loadVideoByPath } from './video-path'

const fixtureFilename = 'acceptance-video.webm'
const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFilename}`, import.meta.url))

test('opens valid Subtitle Siblings and reports broken siblings from the File menu', async ({ page }) => {
  await page.route('**/api/video-loads', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ path: fixturePath })
    await route.fulfill({
      contentType: 'application/json',
      json: {
        loadId: 'load-1',
        video: {
          id: 'video-1',
          filename: fixtureFilename,
          stem: 'acceptance-video',
          mediaUrl: '/api/test-video',
          mimeType: 'video/webm',
        },
        subtitles: [
          {
            id: 'subtitle-1',
            filename: 'acceptance-video.en.srt',
            infixTitle: 'English',
            mediaUrl: '/api/test-subtitle-media',
            textUrl: '/api/test-subtitle-text',
            format: 'srt',
            mimeType: 'application/x-subrip',
          },
          {
            id: 'subtitle-broken',
            filename: 'acceptance-video.de.srt',
            infixTitle: 'German',
            mediaUrl: '/api/test-broken-subtitle-media',
            textUrl: '/api/test-broken-subtitle-text',
            format: 'srt',
            mimeType: 'application/x-subrip',
          },
        ],
        warnings: [],
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
  await page.route('**/api/test-broken-subtitle-text', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      json: { error: 'subtitle file could not be read' },
    })
  })

  await page.goto('/')
  await loadVideoByPath(page, fixturePath)

  await expect(page.getByTestId('reference-video')).toBeVisible()
  await expect(page.getByRole('heading', { name: fixtureFilename })).toBeVisible()
  await expect(page.getByText(/No subtitle tracks yet/)).toHaveCount(0)
  await expect(
    page
      .locator("[data-slot='timeline-workbench-canvas']")
      .locator("[data-slot='timeline-editor-track-header'][aria-label='English']"),
  ).toBeVisible()
  await expect(
    page.getByRole('status').filter({ hasText: 'acceptance-video.de.srt' }),
  ).toContainText('subtitle file could not be read')
})
