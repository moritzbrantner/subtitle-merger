import { mkdir, stat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const videoUrl = 'https://www.youtube.com/watch?v=XTY635NsfuQ'
const fixturePath = fileURLToPath(
  new URL('./fixtures/ogres-are-like-onions-XTY635NsfuQ.mp4', import.meta.url),
)

async function hasCachedFixture() {
  try {
    return (await stat(fixturePath)).size > 0
  } catch {
    return false
  }
}

async function removeEmptyFixture() {
  try {
    if ((await stat(fixturePath)).size === 0) {
      await unlink(fixturePath)
    }
  } catch {
    // A missing fixture is the normal first-run case.
  }
}

async function main() {
  if (await hasCachedFixture()) {
    console.log(`Using cached E2E video fixture: ${fixturePath}`)
    return
  }

  await mkdir(fileURLToPath(new URL('./fixtures/', import.meta.url)), { recursive: true })
  await removeEmptyFixture()

  const ytDlpPath = Bun.which('yt-dlp')

  if (!ytDlpPath) {
    throw new Error(
      'yt-dlp is required for the E2E fixture. Install yt-dlp and re-run `bun run test:e2e`.',
    )
  }

  let download: ReturnType<typeof Bun.spawn>

  try {
    download = Bun.spawn(
      [
        ytDlpPath,
        '--no-playlist',
        '--no-update',
        '--format',
        '18',
        '--output',
        fixturePath,
        videoUrl,
      ],
      {
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
  } catch (error) {
    throw new Error(
      'yt-dlp is required for the E2E fixture. Install yt-dlp and re-run `bun run test:e2e`.',
      { cause: error },
    )
  }

  if ((await download.exited) !== 0 || !(await hasCachedFixture())) {
    throw new Error(`Could not download the E2E video fixture from ${videoUrl}.`)
  }
}

await main()
