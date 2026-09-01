import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'

function parseRange(rangeHeader: string, fileLength: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (!match || fileLength <= 0) return undefined

  const [, rawStart, rawEnd] = match

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return undefined
    return {
      start: Math.max(fileLength - suffixLength, 0),
      end: fileLength - 1,
    }
  }

  const start = Number(rawStart)
  const requestedEnd = rawEnd ? Number(rawEnd) : fileLength - 1
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start >= fileLength) {
    return undefined
  }

  return {
    start,
    end: Math.min(Math.max(requestedEnd, start), fileLength - 1),
  }
}

export async function routeRangeMedia(
  page: Page,
  url: string,
  path: string,
  contentType: string,
) {
  const bytes = await readFile(path)

  await page.route(url, async (route) => {
    const rangeHeader = route.request().headers()['range']

    if (!rangeHeader) {
      await route.fulfill({
        status: 200,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': String(bytes.length),
          'content-type': contentType,
        },
        body: bytes,
      })
      return
    }

    const range = parseRange(rangeHeader, bytes.length)
    if (!range) {
      await route.fulfill({
        status: 416,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': `bytes */${bytes.length}`,
        },
      })
      return
    }

    const chunk = bytes.subarray(range.start, range.end + 1)
    await route.fulfill({
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': String(chunk.length),
        'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`,
        'content-type': contentType,
      },
      body: chunk,
    })
  })
}
