import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const fixtureFilename = 'ogres-are-like-onions-XTY635NsfuQ.mp4'
const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFilename}`, import.meta.url))

test('opens a Reference Video and its Subtitle Sibling from the File menu', async ({ page }) => {
  test.setTimeout(15_000)

  await page.route('**/api/video-picks', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        loadId: 'load-1',
        video: {
          id: 'video-1',
          filename: fixtureFilename,
          stem: 'ogres-are-like-onions-XTY635NsfuQ',
          mediaUrl: '/api/test-video',
          mimeType: 'video/mp4',
        },
        subtitles: [
          {
            id: 'subtitle-1',
            filename: 'ogres-are-like-onions-XTY635NsfuQ.srt',
            infixTitle: 'English',
            mediaUrl: '/api/test-subtitle-media',
            textUrl: '/api/test-subtitle-text',
            format: 'srt',
            mimeType: 'application/x-subrip',
          },
        ],
        warnings: [],
      },
    })
  })
  await page.route('**/api/test-video', async (route) => {
    await route.fulfill({ contentType: 'video/mp4', path: fixturePath })
  })
  await page.route('**/api/test-subtitle-text', async (route) => {
    await route.fulfill({
      contentType: 'application/x-subrip',
      body: '1\n00:00:01,000 --> 00:00:03,000\nOgres are like onions.\n',
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open video…' }).click()

  await expect(page.getByTestId('reference-video')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('heading', { name: fixtureFilename })).toBeVisible()
  await expect(page.getByText(/No subtitle tracks yet/)).toHaveCount(0)
  await expect(
    page
      .locator("[data-slot='timeline-workbench-canvas']")
      .locator("[data-slot='timeline-editor-track-header'][aria-label='English']"),
  ).toBeVisible()
})
