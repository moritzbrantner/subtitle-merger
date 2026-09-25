// Explicit real-network acceptance tier. Never imported by the hermetic check gate.
// Run from the repository root after bun install and playwright install chromium.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { ensureMediaTools, toolWorks } from '../scripts/runtime-tools.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const evidence = path.join(root, '.artifacts/first-run')
const fixture = {
  url: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.7.6/samples/jfk.wav',
  gitBlob: '3184d372cd2f8b804d3a540c70ec50d927b335d2',
  bytes: 352078,
}
const report = {
  schemaVersion: 1,
  status: 'running',
  checkout: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  platform: `${process.platform}-${process.arch}`,
  fixture,
  modelPolicy: 'Unmodified normal-run model defaults; no prefetch, smaller ASR model, or generation mocks. Alignment is attempted normally; the application may retry without word alignment only after the observed recoverable CTC-path mismatch.',
  cacheEvidence: 'Cold downloads populate the explicit application cache. After a full process restart, the backend runs with SUBTITLE_MODEL_CACHE_ONLY=1, a fresh empty HF_HOME and HF_HUB_OFFLINE=1; successful inference plus unchanged model bytes and mtimes proves application-cache reuse.',
  stages: [],
}
let launcher
let browser
let launcherLog

async function receipt() {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2))
}

async function inventory(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await inventory(absolute, relative))
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const metadata = await stat(absolute)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(absolute)) hash.update(chunk)
      files.push({ path: relative, bytes: metadata.size, modifiedMs: metadata.mtimeMs, sha256: hash.digest('hex') })
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (open) => { socket.destroy(); resolve(open) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
}

async function requireStopped(env) {
  const ports = [5173, Number(new URL(`http://${env.SERVER_ADDR}`).port)]
  const deadline = Date.now() + 10000
  while ((await Promise.all(ports.map(portOpen))).some(Boolean)) {
    assert.ok(Date.now() < deadline, 'Launcher shutdown left an editor or backend listening; a warm test must not attach to an old process')
    await delay(100)
  }
}

async function stopLauncher() {
  if (!launcher) return
  const child = launcher
  launcher = undefined
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    const deadline = Date.now() + 15000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  launcherLog?.end()
  launcherLog = undefined
}

async function startLauncher(env, stage) {
  await requireStopped(env)
  launcherLog = createWriteStream(path.join(evidence, `${stage}-launcher.log`))
  launcher = spawn(process.execPath, ['start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let launchError
  launcher.once('error', (error) => { launchError = error })
  launcher.stdout.pipe(launcherLog, { end: false })
  launcher.stderr.pipe(launcherLog, { end: false })
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    if (launcher.exitCode !== null || launcher.signalCode !== null) {
      throw new Error(`bun start exited (${launcher.exitCode ?? launcher.signalCode}); see ${stage}-launcher.log`)
    }
    try {
      const response = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        const logs = await readFile(path.join(evidence, `${stage}-launcher.log`), 'utf8')
        assert.match(logs, /target\/release\/subtitle-merger-backend/, 'normal launcher must execute the optimized native binary')
        return
      }
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error
      // The canonical launcher waits for compilation and backend health.
    }
    await delay(500)
  }
  throw new Error('bun start did not make the editor ready; see launcher log')
}

async function readJobEvents(url, controller, result) {
  const response = await fetch(url, { signal: controller.signal })
  assert.equal(response.status, 200, 'real job SSE must be available')
  let text = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true }).replace(/\r/g, '')
    let boundary
    while ((boundary = text.indexOf('\n\n')) >= 0) {
      const frame = text.slice(0, boundary)
      text = text.slice(boundary + 2)
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
      if (!data) continue
      const job = JSON.parse(data)
      if (result.phases.at(-1) !== job.phase) {
        result.phases.push(job.phase)
        result.phaseEvents.push({ phase: job.phase, elapsedMs: Date.now() - result.startedAtMs })
        console.log(`[${result.name}] ${job.phase}`)
      }
    }
  }
}

function validateTranscript(job, sourceLanguage) {
  assert.equal(job.state, 'completed', job.message)
  assert.equal(job.sourceTrack?.language, sourceLanguage, 'configured source language must propagate to the generated track')
  const text = job.sourceTrack.cues.map((cue) => cue.text).join(' ').toLowerCase()
  assert.match(text, /fellow americans/)
  assert.match(text, /ask not/)
  assert.match(text, /country/)
  for (const cue of job.sourceTrack.cues) {
    assert.ok(Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs))
    assert.ok(cue.startMs >= 0 && cue.endMs > cue.startMs && cue.endMs <= 12000, JSON.stringify(cue))
  }
  return text
}

function expectedCueTexts(track) {
  return track.cues.map((cue) => cue.text.replace(/\r\n/g, '\n').trim())
}

function parseSrtCueTexts(srt) {
  const normalized = srt.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  return normalized.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n')
    const timing = lines.findIndex((line) => line.includes(' --> '))
    assert.ok(timing >= 0, `exported SRT block has no timing line: ${block}`)
    return lines.slice(timing + 1).join('\n').trim()
  })
}

async function generate(stage, videoPath, env, targetLanguage = '', sourceLanguage = 'en') {
  const result = { name: stage, sourceLanguage, targetLanguage, phases: [], phaseEvents: [], pageErrors: [], status: 'running', startedAtMs: Date.now() }
  report.stages.push(result)
  await receipt()
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => result.pageErrors.push(error.stack || error.message || String(error)))
  const controller = new AbortController()
  let eventStream
  try {
    await page.goto('http://127.0.0.1:5173/')
    await page.getByRole('button', { name: 'File', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open video…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Load a video by absolute path' })
    await dialog.getByRole('textbox', { name: 'Absolute video path' }).fill(videoPath)
    await dialog.getByRole('button', { name: 'Load video' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60000 })
    await expect(page.getByTestId('reference-video')).toBeVisible()
    if (env.SUBTITLE_MODEL_CACHE_ONLY === '1') {
      await expect(page.getByText('Automatic AI model downloads are disabled.', { exact: false })).toBeVisible()
      await expect(page.getByText('Missing AI models download automatically', { exact: false })).toHaveCount(0)
    } else {
      await expect(page.getByText('Missing AI models download automatically', { exact: false })).toBeVisible()
      await expect(page.getByText('Automatic AI model downloads are disabled.', { exact: false })).toHaveCount(0)
    }
    await page.getByRole('combobox', { name: 'Spoken language' }).selectOption(sourceLanguage)
    if (targetLanguage) await page.getByRole('combobox', { name: 'Translate to' }).selectOption(targetLanguage)
    const created = page.waitForResponse((response) => response.url().endsWith('/api/subtitle-jobs') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Generate subtitles', exact: true }).click()
    const response = await created
    assert.ok(response.ok(), await response.text())
    let job = await response.json()
    const url = `http://${env.SERVER_ADDR}/api/subtitle-jobs/${job.jobId}`
    eventStream = readJobEvents(`${url}/events`, controller, result).catch((error) => {
      if (!controller.signal.aborted) result.eventError = error.message
    })
    const deadline = Date.now() + 15 * 60 * 1000
    while (!['completed', 'failed', 'cancelled'].includes(job.state)) {
      assert.ok(Date.now() < deadline, `Native inference exceeded the safety timeout: ${job.phase}`)
      const snapshot = await fetch(url, { signal: AbortSignal.timeout(10000) })
      assert.ok(snapshot.ok, `Job snapshot HTTP ${snapshot.status}`)
      job = await snapshot.json()
      result.lastJob = job
      await delay(500)
    }
    result.generationElapsedMs = Date.now() - result.startedAtMs
    await writeFile(path.join(evidence, `${stage}-job.json`), JSON.stringify(job, null, 2))
    result.text = validateTranscript(job, sourceLanguage)
    if (targetLanguage) {
      assert.equal(job.translationTrack?.language, targetLanguage, `Translation did not complete: ${job.message}`)
      const translated = job.translationTrack.cues.map((cue) => cue.text).join(' ')
      assert.ok(translated.trim().length > 20 && translated.toLowerCase() !== result.text)
      result.translation = translated
    }
    await expect(page.getByRole('button', { name: 'Generate subtitles', exact: true })).toBeEnabled({ timeout: 10000 })
    await expect(page.locator(`[data-slot="timeline-editor-clip"][role="button"][aria-label="Subtitles — ${sourceLanguage.toUpperCase()}"]`)).toBeVisible()
    await page.screenshot({ path: path.join(evidence, `${stage}-editor.png`), fullPage: true })
    const exports = [{ label: `Subtitles — ${sourceLanguage.toUpperCase()}`, track: job.sourceTrack, suffix: 'source' }]
    if (targetLanguage) exports.push({ label: `Translation — ${targetLanguage.toUpperCase()}`, track: job.translationTrack, suffix: 'translation' })
    const exportedCueSets = []
    for (const entry of exports) {
      await page.getByRole('button', { name: 'File', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Export subtitles…' }).click()
      await page.getByRole('combobox', { name: 'Track', exact: true }).selectOption({ label: entry.label })
      const downloaded = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export', exact: true }).click()
      const download = await downloaded
      const srtPath = path.join(evidence, `${stage}-${entry.suffix}.srt`)
      await download.saveAs(srtPath)
      const srt = await readFile(srtPath, 'utf8')
      assert.match(srt, /\d{2}:\d{2}:\d{2},\d{3} --> /)
      const actualCues = parseSrtCueTexts(srt)
      const expectedCues = expectedCueTexts(entry.track)
      assert.deepEqual(actualCues, expectedCues, 'export must contain exactly the selected generated track and no cues from another track')
      exportedCueSets.push({ suffix: entry.suffix, cues: actualCues })
    }
    if (targetLanguage) {
      assert.notDeepEqual(exportedCueSets[0].cues, exportedCueSets[1].cues, 'source and translated exports must remain distinct selected tracks')
    }
    result.exports = exportedCueSets
    assert.deepEqual(result.pageErrors, [], 'the real editor must not throw')
    assert.equal(result.eventError, undefined, 'phase evidence requires an intact SSE subscription')
    assert.equal(launcher.exitCode, null, 'the launcher must still own the running application')
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'
    result.error = error.stack ?? String(error)
    await page.screenshot({ path: path.join(evidence, `${stage}-failure.png`), fullPage: true }).catch(() => {})
    throw error
  } finally {
    result.elapsedMs = Date.now() - result.startedAtMs
    controller.abort()
    await eventStream
    await context.close()
    await receipt()
  }
  return result
}

async function main() {
  await mkdir(evidence, { recursive: true })
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'subtitle-native-first-run-'))
  const models = path.join(workspace, 'models')
  const tools = path.join(workspace, 'tools')
  await mkdir(models)
  report.modelCacheInitiallyEmpty = (await readdir(models)).length === 0
  assert.ok(report.modelCacheInitiallyEmpty)
  const env = {
    ...process.env,
    SUBTITLE_MODEL_CACHE_DIR: models,
    SUBTITLE_TOOLS_CACHE_DIR: tools,
    SUBTITLE_OPEN_BROWSER: '0',
    SERVER_ADDR: `127.0.0.1:${await freePort()}`,
    HF_HOME: path.join(workspace, 'huggingface'),
  }
  delete env.HF_TOKEN
  delete env.HUGGING_FACE_HUB_TOKEN
  delete env.HF_HUB_OFFLINE
  delete env.SUBTITLE_AUTO_DOWNLOAD_TOOLS
  await receipt()
  console.log('Downloading and executing the real FFmpeg tools into an empty app cache')
  const runtimeEnv = await ensureMediaTools({
    env,
    // Simulate PATH absence only, never network responses or executable bytes.
    works: (command, name, environment) => path.isAbsolute(command) && toolWorks(command, name, environment),
  })
  report.tools = { status: 'passed', files: await inventory(tools) }
  await receipt()
  const audioResponse = await fetch(fixture.url, { signal: AbortSignal.timeout(60000) })
  assert.ok(audioResponse.ok, `Speech fixture HTTP ${audioResponse.status}`)
  const audio = Buffer.from(await audioResponse.arrayBuffer())
  assert.equal(audio.length, fixture.bytes)
  assert.equal(createHash('sha1').update(`blob ${audio.length}\0`).update(audio).digest('hex'), fixture.gitBlob)
  const audioPath = path.join(workspace, 'speech.wav')
  const videoPath = path.join(workspace, 'speech.mp4')
  await writeFile(audioPath, audio)
  const encode = spawnSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x182332:s=640x360:r=12',
    '-i', audioPath, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', videoPath,
  ], { env: runtimeEnv, encoding: 'utf8', timeout: 60000 })
  assert.equal(encode.status, 0, encode.stderr || encode.error?.message)
  await startLauncher(runtimeEnv, 'cold')
  browser = await chromium.launch({ headless: true })
  const cold = await generate('cold-source', videoPath, runtimeEnv)
  assert.ok(cold.phases.includes('downloadingModels'), 'cold run must report model resolution downloads')
  report.coldModels = await inventory(models)
  assert.ok(report.coldModels.some((file) => file.bytes > 1000000), 'models must actually be written')
  await receipt()
  const translation = await generate('cold-translation', videoPath, runtimeEnv, 'de')
  assert.ok(translation.phases.includes('downloadingModels'), 'new translation route must resolve its model')
  report.translationModels = await inventory(models)
  assert.ok(report.translationModels.length > report.coldModels.length)
  await receipt()
  await stopLauncher()
  await requireStopped(runtimeEnv)
  report.restartVerified = true
  const warmHfHome = path.join(workspace, 'huggingface-warm-empty')
  await mkdir(warmHfHome)
  const warmEnv = {
    ...runtimeEnv,
    SUBTITLE_AUTO_DOWNLOAD_TOOLS: '0',
    SUBTITLE_MODEL_CACHE_ONLY: '1',
    HF_HOME: warmHfHome,
    HF_HUB_OFFLINE: '1',
  }
  await startLauncher(warmEnv, 'warm')
  const preflightResponse = await fetch(`http://${warmEnv.SERVER_ADDR}/api/generation-preflight`)
  assert.ok(preflightResponse.ok, `warm preflight HTTP ${preflightResponse.status}`)
  const warmPreflight = await preflightResponse.json()
  assert.equal(warmPreflight.modelDownloadsAutomatic, false, 'warm backend must enforce application cache-only model resolution')
  report.warmCacheOnly = warmPreflight
  const oldJob = await fetch(`http://${warmEnv.SERVER_ADDR}/api/subtitle-jobs/${translation.lastJob.jobId}`)
  assert.equal(oldJob.status, 404, 'new backend must not be the previous in-memory job registry')
  await generate('warm-restarted', videoPath, warmEnv, 'de')
  report.warmModels = await inventory(models)
  report.warmHfHome = await inventory(warmHfHome)
  assert.deepEqual(report.warmHfHome, [], 'cache-only warm run must not populate or rely on a hidden Hugging Face cache')
  assert.deepEqual(report.warmModels, report.translationModels, 'cached model contents and modification times must be reused unchanged')
  report.status = 'passed'
}

main().catch((error) => {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  console.error(report.error)
  process.exitCode = 1
}).finally(async () => {
  await browser?.close()
  await stopLauncher()
  await receipt()
  console.log(JSON.stringify(report, null, 2))
})
