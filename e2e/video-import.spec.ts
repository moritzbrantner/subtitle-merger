import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const fixtureFilename = 'ogres-are-like-onions-XTY635NsfuQ.mp4'
const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFilename}`, import.meta.url))

test('opens a Reference Video with the native file chooser and no video timeline item', async ({
  page,
}) => {
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
        subtitles: [],
        warnings: [],
      },
    })
  })
  await page.route('**/api/test-video', async (route) => {
    await route.fulfill({ contentType: 'video/mp4', path: fixturePath })
  })
  await page.goto('/')

  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open video…' }).click()

  const timelineCanvas = page.locator("[data-slot='timeline-workbench-canvas']")
  await expect(page.getByTestId('reference-video')).toBeVisible()
  await expect(page.getByRole('heading', { name: fixtureFilename })).toBeVisible()
  await expect(timelineCanvas.getByRole('button', { name: fixtureFilename, exact: true })).toHaveCount(0)
  await expect(page.locator("[data-slot='timeline-workbench-assets']")).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('No subtitle tracks yet')
})
