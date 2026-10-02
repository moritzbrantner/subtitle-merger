import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

type Fixture = {
  url: URL
  codecArgs: string[]
}

const fixtures: Fixture[] = [
  {
    url: new URL('./fixtures/acceptance-video.webm', import.meta.url),
    codecArgs: [
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
    ],
  },
  {
    url: new URL('./fixtures/acceptance-video.mp4', import.meta.url),
    codecArgs: [
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
    ],
  },
]

for (const fixture of fixtures) {
  const fixturePath = fileURLToPath(fixture.url)
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
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      ...fixture.codecArgs,
      '-shortest',
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
}
