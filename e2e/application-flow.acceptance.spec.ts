import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fixtureFilename = 'acceptance-video.webm'
const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureFilename}`, import.meta.url))

const queuedJob = {
  jobId: 'job-1',
  sessionId: 'session-1',
  state: 'queued',
  phase: 'queued',
  progress: 0,
  message: 'subtitle generation queued',
  sourceTrack: null,
  translationTrack: null,
}

const completedJob = {
  jobId: 'job-1',
  sessionId: 'session-1',
  state: 'completed',
  phase: 'completed',
  progress: 100,
  message: 'source subtitles generated',
  sourceTrack: {
    language: 'en',
    pivoted: false,
    cues: [
      {
        startMs: 500,
        endMs: 1_500,
        text: 'Generated subtitle',
      },
    ],
  },
  translationTrack: null,
}

test('opens, generates, edits and exports subtitles through the application shell', async ({ page }) => {
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`)
  })
  page.on('requestfailed', (request) => {
    const url = request.url()
    if (!url.includes('/api/subtitle-jobs/job-1/events')) {
      browserErrors.push(`request failed: ${url}: ${request.failure()?.errorText ?? 'unknown'}`)
    }
  })

  await page.route('**/api/video-picks', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        loadId: 'load-acceptance',
        video: {
          id: 'video-acceptance',
          filename: fixtureFilename,
          stem: 'acceptance-video',
          mediaUrl: '/api/acceptance-video',
          mimeType: 'video/webm',
        },
        subtitles: [],
        warnings: [],
      },
    })
  })
  await page.route('**/api/acceptance-video', async (route) => {
    await route.fulfill({ contentType: 'video/webm', path: fixturePath })
  })
  await page.route('**/api/subtitle-sessions', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { sessionId: 'session-1' } })
  })
  await page.route('**/api/subtitle-jobs', async (route) => {
    expect(route.request().method()).toBe('POST')
    await route.fulfill({ contentType: 'application/json', json: queuedJob })
  })
  await page.route('**/api/subtitle-jobs/job-1/events', async (route) => {
    await route.abort('connectionrefused')
  })
  await page.route('**/api/subtitle-jobs/job-1', async (route) => {
    expect(route.request().method()).toBe('GET')
    await route.fulfill({ contentType: 'application/json', json: completedJob })
  })

  await page.goto('/')
  await page.waitForTimeout(750)

  expect(browserErrors, `Browser startup errors:\n${browserErrors.join('\n\n')}`).toEqual([])

  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open video…' }).click()

  await expect(page.getByTestId('reference-video')).toBeVisible()
  await expect(page.getByRole('heading', { name: fixtureFilename })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Generate subtitles' })).toBeVisible()

  await page.getByRole('button', { name: 'Generate subtitles', exact: true }).click()

  const subtitleClip = page.getByRole('button', { name: 'Subtitles — EN', exact: true })
  await expect(subtitleClip).toBeVisible()
  await subtitleClip.focus()
  await subtitleClip.press('ArrowRight')

  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Export subtitles…' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Track' })).toHaveValue(/subtitle-/)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()

  expect(download.suggestedFilename()).toBe('subtitles-en.srt')
  expect(downloadPath).not.toBeNull()

  const exported = await readFile(downloadPath!, 'utf8')
  expect(exported).toContain('00:00:00,600 --> 00:00:01,600')
  expect(exported).toContain('Generated subtitle')
})
