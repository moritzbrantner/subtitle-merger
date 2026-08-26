import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const fixtureUrl = new URL('./fixtures/acceptance-video.webm', import.meta.url)
const fixturePath = fileURLToPath(fixtureUrl)

mkdirSync(dirname(fixturePath), { recursive: true })

const result = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:d=2:r=24',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-y',
    fixturePath,
  ],
  { stdio: 'inherit' },
)

if (result.error) {
  throw new Error(`Could not start ffmpeg: ${result.error.message}`)
}

if (result.status !== 0) {
  throw new Error(`ffmpeg exited with status ${result.status ?? 'unknown'}`)
}

console.log(`Prepared deterministic browser fixture: ${fixturePath}`)
