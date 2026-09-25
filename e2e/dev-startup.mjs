// Deterministic browser boundary: ordinary Vite startup, without source overrides.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'

const output = '.artifacts/first-run'
await mkdir(output, { recursive: true })
const socket = createServer()
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const url = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['run', '--cwd', 'frontend', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
})
const result = { status: 'running', pageErrors: [], browserExceptions: [], consoleErrors: [], failedRequests: [], httpErrors: [] }
let logs = ''
child.stdout.on('data', (chunk) => { logs += chunk })
child.stderr.on('data', (chunk) => { logs += chunk })
child.on('error', (error) => { result.launchError = error.message })
let browser
let page
const scriptBodies = []
try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (result.launchError || child.exitCode !== null) throw new Error(result.launchError ?? logs)
    try { ready = (await fetch(url, { signal: AbortSignal.timeout(500) })).ok } catch { /* waiting for Vite */ }
    if (ready) break
    await delay(250)
  }
  if (!ready) throw new Error('Ordinary Vite server did not start')
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(15000)
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Runtime.exceptionThrown', (event) => result.browserExceptions.push(event.exceptionDetails))
  await cdp.send('Runtime.enable')
  await page.addInitScript(() => {
    window.__startupErrors = []
    window.addEventListener('error', (event) => window.__startupErrors.push({
      message: event.message, filename: event.filename, line: event.lineno,
      error: String(event.error), stack: event.error?.stack,
    }))
  })
  page.on('pageerror', (error) => result.pageErrors.push(error.stack || error.message || String(error)))
  page.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(message.text()) })
  page.on('requestfailed', (request) => result.failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`))
  page.on('response', (response) => {
    if (response.status() >= 400) result.httpErrors.push(`${response.status()} ${response.url()}`)
    if (response.request().resourceType() === 'script') {
      scriptBodies.push(response.text().then((body) => ({ url: response.url(), body })).catch(() => ({ url: response.url(), body: '<unavailable>' })))
    }
  })
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Open video…' })).toBeVisible()
  if (result.pageErrors.length || result.consoleErrors.length) throw new Error('Editor startup emitted browser errors')
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  if (page) {
    result.windowErrors = await page.evaluate(() => window.__startupErrors).catch(() => [])
    await page.screenshot({ path: `${output}/dev-startup.png`, fullPage: true }).catch(() => {})
    await writeFile(`${output}/dev-startup.html`, await page.content().catch(() => ''))
  }
  if (result.status === 'failed') await writeFile(`${output}/dev-startup-scripts.json`, JSON.stringify(await Promise.all(scriptBodies)))
  await browser?.close()
  if (process.platform === 'win32') child.kill('SIGTERM')
  else { try { process.kill(-child.pid, 'SIGTERM') } catch { /* already stopped */ } }
  await writeFile(`${output}/dev-startup.log`, logs)
  await writeFile(`${output}/dev-startup.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
