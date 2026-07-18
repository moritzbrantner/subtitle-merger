import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const fixtureFilename = 'long-duration-90m.mp4'
const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFilename}`, import.meta.url))

test('maximum zoom out fits the Reference Video and keeps the zoom control readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1657, height: 505 })
  await page.route('**/api/video-picks', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        loadId: 'load-zoom',
        video: {
          id: 'video-zoom',
          filename: fixtureFilename,
          stem: 'long-duration-90m',
          mediaUrl: '/api/test-long-video',
          mimeType: 'video/mp4',
        },
        subtitles: [
          {
            id: 'subtitle-zoom-srt',
            filename: 'long-duration-90m.srt',
            infixTitle: 'SRT',
            mediaUrl: '/api/test-zoom-subtitle-srt',
            textUrl: '/api/test-zoom-subtitle-text',
            format: 'srt',
            mimeType: 'application/x-subrip',
          },
          {
            id: 'subtitle-zoom-vtt',
            filename: 'long-duration-90m.vtt',
            infixTitle: 'VTT',
            mediaUrl: '/api/test-zoom-subtitle-vtt',
            textUrl: '/api/test-zoom-subtitle-text',
            format: 'srt',
            mimeType: 'application/x-subrip',
          },
        ],
        warnings: [],
      },
    })
  })
  await page.route('**/api/test-long-video', async (route) => {
    await route.fulfill({ contentType: 'video/mp4', path: fixturePath })
  })
  await page.route('**/api/test-zoom-subtitle-text', async (route) => {
    await route.fulfill({
      contentType: 'application/x-subrip',
      body: '1\n00:00:01,000 --> 01:30:00,000\nOnce upon a time, there was a movie called Shrek.\n',
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open video…' }).click()
  await expect(page.getByTestId('reference-video')).toBeVisible()

  const zoomSlider = page.getByRole('slider')
  await zoomSlider.press('Home')

  const sliderBox = await zoomSlider.boundingBox()
  const zoomLabelBox = await page.getByText('Zoom', { exact: true }).boundingBox()

  expect(sliderBox).not.toBeNull()
  expect(zoomLabelBox).not.toBeNull()
  expect(sliderBox?.width).toBeGreaterThanOrEqual(80)
  expect(sliderBox?.x).toBeGreaterThanOrEqual((zoomLabelBox?.x ?? 0) + (zoomLabelBox?.width ?? 0) + 8)

  await expect(zoomSlider).toHaveAttribute('aria-valuenow', /^0\./)
  const editorMetrics = await page.locator("[data-slot='timeline-editor']").evaluate((editor) => {
    const editorRect = editor.getBoundingClientRect()

    return {
      horizontalOverflow: editor.scrollWidth - editor.clientWidth,
      overhangingElements: [...editor.querySelectorAll<HTMLElement>('*')]
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            slot: element.dataset['slot'],
            className: element.className,
            right: Math.round(rect.right - editorRect.left),
            width: Math.round(rect.width),
          }
        })
        .filter(({ right }) => right > editor.clientWidth + 2)
        .slice(0, 20),
    }
  })

  expect(editorMetrics.horizontalOverflow).toBeLessThanOrEqual(2)
  expect(editorMetrics.overhangingElements).toEqual([])
})
