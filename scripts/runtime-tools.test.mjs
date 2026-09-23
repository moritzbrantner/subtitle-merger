import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { downloadTool, ensureMediaTools, toolCacheRoot, withToolPath } from './runtime-tools.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subtitle-tools-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  return {
    root, calls,
    options: {
      env: { PATH: '/system' }, platform: 'linux', arch: 'x64', cacheRoot: root,
      works: (command) => path.isAbsolute(command) && existsSync(command),
      download: async ({ name, destination }) => { calls.push(name); await writeFile(destination, name) },
      log: () => {},
    },
  }
}

test('a working system installation is reused without touching the cache or network', async () => {
  const env = { PATH: '/system' }
  const result = await ensureMediaTools({
    env, works: () => true,
    download: () => { throw new Error('unexpected download') },
  })
  assert.deepEqual(result, env)
  assert.notEqual(result, env, 'child environment must not mutate the parent')
})

test('cold setup installs both tools and warm offline setup performs no downloads', async (t) => {
  const { root, calls, options } = await fixture(t)
  const installed = await ensureMediaTools(options)
  assert.deepEqual(calls, ['ffmpeg', 'ffprobe'])
  const directory = installed.PATH.split(':')[0]
  assert.equal(await readFile(path.join(directory, 'ffmpeg'), 'utf8'), 'ffmpeg')
  assert.equal(JSON.parse(await readFile(path.join(directory, 'SOURCE.json'), 'utf8')).release, 'b6.1.2-rc.1')
  const warm = await ensureMediaTools({
    ...options, env: { PATH: '/system', SUBTITLE_AUTO_DOWNLOAD_TOOLS: '0' },
    download: () => { throw new Error('offline cache must not download') },
  })
  assert.equal(warm.PATH, installed.PATH)
  assert.equal((await readdir(root)).length, 1)
})

test('a partial installation is discarded and the next attempt succeeds', async (t) => {
  const { root, options } = await fixture(t)
  await assert.rejects(ensureMediaTools({
    ...options,
    download: async ({ name, destination }) => {
      await writeFile(destination, 'partial')
      if (name === 'ffprobe') throw new Error('connection lost')
    },
  }), /connection lost/)
  assert.deepEqual(await readdir(root), [])
  await ensureMediaTools(options)
  assert.equal((await readdir(root)).length, 1)
})

test('downloads disabled with an empty cache produce an actionable error', async (t) => {
  const { options } = await fixture(t)
  await assert.rejects(ensureMediaTools({
    ...options, env: { SUBTITLE_AUTO_DOWNLOAD_TOOLS: '0' },
  }), /downloads are disabled/)
})

test('unsupported platforms never guess a binary', async () => {
  await assert.rejects(ensureMediaTools({ platform: 'unknown', arch: 'unknown', works: () => false }), /not available/)
})

test('Windows PATH keys are normalized without duplicates', () => {
  const result = withToolPath('C:\\tools', { Path: 'C:\\system', OTHER: 'yes' }, 'win32')
  assert.equal(result.PATH, 'C:\\tools;C:\\system')
  assert.equal(result.Path, undefined)
  assert.equal(result.OTHER, 'yes')
})

test('an explicit tools cache override wins over OS defaults', () => {
  assert.equal(toolCacheRoot({ SUBTITLE_TOOLS_CACHE_DIR: './custom' }), path.resolve('./custom'))
})

for (const [name, response, pattern] of [
  ['HTTP failure', () => new Response('no', { status: 503 }), /HTTP 503/],
  ['wrong content length', () => new Response('bad', { headers: { 'content-length': '3' } }), /unexpected size/],
  ['truncated response', () => new Response('bad'), /interrupted/],
  ['oversized response', () => new Response('too much'), /exceeds/],
]) {
  test(`download rejects ${name} and leaves no executable`, async (t) => {
    const { root } = await fixture(t)
    const destination = path.join(root, 'ffmpeg')
    await assert.rejects(downloadTool({ id: 1, size: 4, name: 'ffmpeg', destination, fetcher: async () => response(), log: () => {} }), pattern)
    assert.equal(existsSync(destination), false)
  })
}

test('complete bytes are streamed to disk and the fixed asset endpoint is used', async (t) => {
  const { root } = await fixture(t)
  const destination = path.join(root, 'ffmpeg')
  const logs = []
  await downloadTool({
    id: 123, size: 4, name: 'ffmpeg', destination, log: (message) => logs.push(message),
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/descriptinc/ffmpeg-ffprobe-static/releases/assets/123')
      assert.equal(options.headers.Accept, 'application/octet-stream')
      return new Response('good', { headers: { 'content-length': '4' } })
    },
  })
  assert.equal(await readFile(destination, 'utf8'), 'good')
  assert.ok(logs.some((message) => message.includes('100%')))
})
