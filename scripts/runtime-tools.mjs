import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Fixed GitHub asset IDs, not a moving "latest" URL. Source/build information:
// https://github.com/descriptinc/ffmpeg-ffprobe-static/releases/tag/b6.1.2-rc.1
// Replacing a release asset assigns a new ID. Sizes also reject error pages and truncation.
export const mediaToolRelease = 'b6.1.2-rc.1'
export const mediaToolAssets = {
  'win32-x64': { ffmpeg: [202650095, 126518784], ffprobe: [202650087, 126382080] },
  'linux-x64': { ffmpeg: [202650088, 128513072], ffprobe: [202650093, 128374768] },
  'linux-arm64': { ffmpeg: [202650085, 92424880], ffprobe: [202650089, 92364464] },
  'darwin-x64': { ffmpeg: [202650083, 75991688], ffprobe: [202650090, 75917176] },
  'darwin-arm64': { ffmpeg: [202650084, 47078120], ffprobe: [202650098, 47037128] },
}

export function toolCacheRoot(env = process.env, platform = process.platform, home = homedir()) {
  if (env.SUBTITLE_TOOLS_CACHE_DIR) return path.resolve(env.SUBTITLE_TOOLS_CACHE_DIR)
  const root = platform === 'win32'
    ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : env.XDG_CACHE_HOME || path.join(home, '.cache')
  return path.join(root, 'subtitle-merger', 'tools')
}

export function toolWorks(command, name, env = process.env) {
  const result = spawnSync(command, ['-version'], {
    env, encoding: 'utf8', timeout: 10000, windowsHide: true,
  })
  return result.status === 0 && result.stdout?.startsWith(`${name} version `) === true
}

export function withToolPath(directory, env = process.env, platform = process.platform) {
  const next = { ...env }
  // Windows environment keys are case insensitive; never pass both Path and PATH.
  const key = Object.keys(next).find((name) => name.toUpperCase() === 'PATH') || 'PATH'
  const value = next[key] || ''
  for (const name of Object.keys(next)) {
    if (name.toUpperCase() === 'PATH') delete next[name]
  }
  next.PATH = `${directory}${platform === 'win32' ? ';' : ':'}${value}`
  return next
}

export async function downloadTool({ id, size, name, destination, fetcher = fetch, log = console.log, signal }) {
  const response = await fetcher(
    `https://api.github.com/repos/descriptinc/ffmpeg-ffprobe-static/releases/assets/${id}`,
    {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'subtitle-merger-setup' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000),
    },
  )
  if (!response.ok || !response.body) {
    throw new Error(`${name} download failed (HTTP ${response.status}). Check your connection and run bun start again.`)
  }
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) !== size) {
    await response.body.cancel()
    throw new Error(`${name} download has an unexpected size; refusing to install it.`)
  }
  let received = 0
  let lastStep = -1
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > size) return callback(new Error(`${name} download exceeds its pinned size.`))
      const step = Math.floor(received / size * 20)
      if (step !== lastStep) {
        lastStep = step
        log(`Downloading ${name}: ${Math.floor(received / size * 100)}%`)
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(destination, { flags: 'wx', mode: 0o755 }))
    if (received !== size) throw new Error(`${name} download was interrupted; run bun start to retry.`)
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
}

export async function ensureMediaTools({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  cacheRoot = toolCacheRoot(env, platform),
  assets = mediaToolAssets[`${platform}-${arch}`],
  works = toolWorks,
  download = downloadTool,
  log = console.log,
  signal,
} = {}) {
  const names = ['ffmpeg', 'ffprobe']
  if (names.every((name) => works(name, name, env))) return { ...env }
  if (!assets) {
    throw new Error(`Automatic FFmpeg setup is not available for ${platform}-${arch}. Install ffmpeg and ffprobe on PATH, then run bun start again.`)
  }
  const directory = path.join(cacheRoot, `${mediaToolRelease}-${platform}-${arch}`)
  const filename = (name) => `${name}${platform === 'win32' ? '.exe' : ''}`
  const usable = (dir) => names.every((name) => works(path.join(dir, filename(name)), name, env))
  if (usable(directory)) return withToolPath(directory, env, platform)
  if (env.SUBTITLE_AUTO_DOWNLOAD_TOOLS === '0') {
    throw new Error('FFmpeg/ffprobe are missing and automatic tool downloads are disabled. Install them on PATH or remove SUBTITLE_AUTO_DOWNLOAD_TOOLS=0.')
  }

  await mkdir(cacheRoot, { recursive: true })
  const staging = await mkdtemp(path.join(cacheRoot, '.ffmpeg-install-'))
  try {
    log('FFmpeg is needed for subtitle generation. Installing an app-local copy; no administrator access is required.')
    for (const name of names) {
      const [id, size] = assets[name]
      await download({ id, size, name, destination: path.join(staging, filename(name)), log, signal })
    }
    if (!usable(staging)) throw new Error('Downloaded FFmpeg tools cannot run on this machine. Install a compatible FFmpeg build on PATH and retry.')
    await writeFile(path.join(staging, 'SOURCE.json'), JSON.stringify({
      repository: 'descriptinc/ffmpeg-ffprobe-static', release: mediaToolRelease,
      platform, arch, assets,
      source: `https://github.com/descriptinc/ffmpeg-ffprobe-static/releases/tag/${mediaToolRelease}`,
    }, null, 2))
    // A concurrent launcher may have finished while this one was downloading.
    if (!usable(directory)) {
      await rm(directory, { recursive: true, force: true })
      try {
        await rename(staging, directory)
      } catch (error) {
        if (!usable(directory)) throw error
      }
    }
    return withToolPath(directory, env, platform)
  } finally {
    // Failed/partial downloads are never considered installed on the next start.
    await rm(staging, { recursive: true, force: true })
  }
}
