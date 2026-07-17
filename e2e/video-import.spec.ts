import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const fixtureFilename = 'ogres-are-like-onions-XTY635NsfuQ.mp4'
const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFilename}`, import.meta.url))

test('imports, thumbnails, previews, and plays a real video from the File menu', async ({
  page,
}) => {
  await page.goto('/')

  const fileMenuButton = page.getByRole('button', { name: 'File', exact: true })
  await expect(fileMenuButton).toBeVisible()

  const fileChooserPromise = page.waitForEvent('filechooser')
  await fileMenuButton.click()
  await page.getByRole('menuitem', { name: 'Open video…' }).click()
  await (await fileChooserPromise).setFiles(fixturePath)

  const assetsPanel = page.locator("[data-slot='timeline-workbench-assets']")
  const timelineCanvas = page.locator("[data-slot='timeline-workbench-canvas']")
  const transport = page.locator("[data-slot='timeline-workbench-transport']")
  const previewVideo = page.locator("video[data-slot='timeline-workbench-scene-video']")

  await expect(
    assetsPanel.getByRole('button', { name: fixtureFilename, exact: true }),
  ).toBeVisible()
  await expect(
    timelineCanvas.getByRole('button', { name: fixtureFilename, exact: true }),
  ).toBeVisible()
  await expect(transport).toContainText(/0:00\.0 \/ 2:24\.\d/)
  await expect(
    timelineCanvas.locator("[data-slot='timeline-media-video-thumbnail']"),
  ).toHaveCount(12)
  await expect(previewVideo).toBeVisible()
  await expect
    .poll(
      () =>
        previewVideo.evaluate(
          (video) =>
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            Number.isFinite(video.duration) &&
            video.duration > 140 &&
            video.duration < 150 &&
            video.error === null,
        ),
    )
    .toBe(true)
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect.poll(() => previewVideo.evaluate((video) => video.currentTime)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
})
