import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { ensureMediaTools } from './runtime-tools.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const children = new Set()
const controller = new AbortController()
let stopping = false

function stop(code) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  controller.abort()
  for (const child of children) {
    if (!child.pid) continue
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
      }, 3000)
      timer.unref()
    }
  }
}

function launch(command, args, env) {
  const child = spawn(command, args, {
    cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32',
  })
  children.add(child)
  child.once('error', (error) => { console.error(error.message); stop(1) })
  child.once('exit', (code) => {
    // Stop the whole process tree, including children of cargo/bun.
    if (!stopping) stop(code === 0 ? 0 : 1)
    children.delete(child)
  })
  return child
}

async function main() {
  if (!process.versions.bun) throw new Error('Start the app with bun start (Bun 1.3.14 or compatible).')
  for (const command of ['cargo', 'git']) {
    if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0) {
      throw new Error(`${command} is required to build the native app. Install the Rust toolchain and Git, then run bun start again.`)
    }
  }
  process.once('SIGINT', () => stop(130))
  process.once('SIGTERM', () => stop(143))

  const backendUrl = new URL(`http://${process.env.SERVER_ADDR || '127.0.0.1:3000'}`)
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(backendUrl.hostname)) {
    throw new Error('The local launcher requires a loopback SERVER_ADDR; the API can access local files.')
  }
  if (!backendUrl.port || Number(backendUrl.port) < 1 || backendUrl.username || backendUrl.password
    || backendUrl.pathname !== '/' || backendUrl.search || backendUrl.hash) {
    throw new Error('SERVER_ADDR must be a loopback IP and a port, for example 127.0.0.1:3000.')
  }
  if (backendUrl.hostname === 'localhost') backendUrl.hostname = '127.0.0.1'
  const address = backendUrl.host
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`Backend port ${address} is occupied or unavailable. Stop the other instance or change SERVER_ADDR.`)))
    probe.listen(Number(backendUrl.port), backendUrl.hostname.replace(/^\[|\]$/g, ''), () => probe.close(resolve))
  })
  console.log('Installing frontend dependencies from bun.lock…')
  // Use Bun directly rather than a shell, including on Windows.
  const install = spawnSync(process.execPath, ['install', '--frozen-lockfile'], {
    cwd: root, env: process.env, stdio: 'inherit',
  })
  if (install.status !== 0) throw new Error('Dependency installation failed. Fix the error above and run bun start again.')

  const env = await ensureMediaTools({ signal: controller.signal })
  if (stopping) return
  env.SERVER_ADDR = address
  env.VITE_BACKEND_URL = backendUrl.origin
  console.log('Building and starting the optimized native backend. The first build takes longer; subsequent starts reuse it. AI models download only when generation needs them.')
  // CPU inference must not run in Cargo's unoptimized development profile.
  // The separate dev:backend command remains available for native debugging.
  launch('cargo', ['run', '--release', '--locked', '--manifest-path', 'backend/Cargo.toml'], env)

  // Do not open an apparently ready editor while the first native build is still running.
  while (!stopping) {
    try {
      const response = await fetch(new URL('/api/health', backendUrl), { signal: AbortSignal.timeout(1000) })
      if (response.ok && (await response.json()).service === 'subtitle-merger-backend') break
    } catch { /* backend is still compiling/starting; its exit handler handles failures */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (stopping) return
  const args = ['run', '--cwd', 'frontend', 'dev', '--host', '127.0.0.1', '--strictPort']
  if (env.SUBTITLE_OPEN_BROWSER !== '0') args.push('--open')
  launch(process.execPath, args, env)
}

main().catch((error) => {
  if (!stopping) console.error(`Startup failed: ${error.message}`)
  stop(1)
})
