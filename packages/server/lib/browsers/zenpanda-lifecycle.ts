/**
 * ZenPanda lifecycle management — auto-start via Docker, WSL, or native binary
 * when no running instance is detected at the configured CDP endpoint.
 *
 * Config (cypress.config.ts):
 *   zenpanda.host        — CDP host (default: 127.0.0.1)
 *   zenpanda.port        — CDP port (default: 9222)
 *   zenpanda.autoStart   — start ZenPanda if not running (default: true)
 *   zenpanda.docker      — prefer Docker to start (default: auto-detect)
 *   zenpanda.dockerImage — Docker image (default: lightpanda/browser:nightly)
 *   zenpanda.stopAfterRun — stop container when tests finish (default: false)
 */

import { execSync, spawn, type ChildProcess } from 'child_process'
import http from 'http'
import Debug from 'debug'

const debug = Debug('cypress:server:browsers:zenpanda-lifecycle')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9222
const DEFAULT_DOCKER_IMAGE = 'lightpanda/browser:nightly'
const CONTAINER_NAME = 'cypress-zenpanda'
const HEALTHCHECK_TIMEOUT_MS = 15_000
const HEALTHCHECK_POLL_MS = 300

export interface ZenPandaLifecycleConfig {
  host?: string
  port?: number
  autoStart?: boolean
  docker?: boolean
  dockerImage?: string
  stopAfterRun?: boolean
}

let managedContainerName: string | null = null
let managedChildProcess: ChildProcess | null = null

function getConfig (raw: Record<string, unknown> = {}): Required<ZenPandaLifecycleConfig> {
  return {
    host: (raw.host as string) || process.env.ZENPANDA_HOST || DEFAULT_HOST,
    port: Number(raw.port || process.env.ZENPANDA_PORT || DEFAULT_PORT),
    autoStart: raw.autoStart !== false,
    docker: raw.docker as boolean ?? undefined as any, // auto-detect below
    dockerImage: (raw.dockerImage as string) || DEFAULT_DOCKER_IMAGE,
    stopAfterRun: raw.stopAfterRun === true,
  }
}

function probeEndpoint (host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/json/version', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })

    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function waitForEndpoint (host: string, port: number): Promise<void> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() > deadline) {
        return reject(new Error(`ZenPanda did not become ready at ${host}:${port} within ${HEALTHCHECK_TIMEOUT_MS}ms`))
      }

      probeEndpoint(host, port, HEALTHCHECK_POLL_MS).then((ok) => {
        if (ok) return resolve()
        setTimeout(poll, HEALTHCHECK_POLL_MS)
      })
    }

    poll()
  })
}

function dockerAvailable (): boolean {
  try {
    execSync('docker info --format "{{.ServerVersion}}"', { stdio: 'pipe', timeout: 3000 })

    return true
  } catch {
    return false
  }
}

function dockerContainerRunning (name: string): boolean {
  try {
    const out = execSync(`docker ps --filter name=${name} --format "{{.Names}}"`, { stdio: 'pipe' })

    return out.toString().includes(name)
  } catch {
    return false
  }
}

function startDockerContainer (image: string, host: string, port: number): string {
  const name = CONTAINER_NAME

  debug('starting Docker container %s from image %s on port %d', name, image, port)

  const bindHost = host === '127.0.0.1' || host === 'localhost' ? '127.0.0.1' : host

  execSync(
    `docker run -d --rm --name ${name} -p ${bindHost}:${port}:${port} ${image}`,
    { stdio: 'pipe' },
  )

  return name
}

function nativeBinaryAvailable (): boolean {
  for (const bin of ['zenpanda', 'lightpanda']) {
    try {
      execSync(`which ${bin}`, { stdio: 'pipe' })

      return true
    } catch { /* continue */ }
  }

  return false
}

function startNativeBinary (port: number): ChildProcess {
  for (const bin of ['zenpanda', 'lightpanda']) {
    try {
      execSync(`which ${bin}`, { stdio: 'pipe' })
      debug('starting native binary %s on port %d', bin, port)

      return spawn(bin, ['serve', '--port', String(port)], { stdio: 'ignore', detached: false })
    } catch { /* try next */ }
  }

  throw new Error('No ZenPanda/Lightpanda binary found in PATH')
}

function wslBinaryAvailable (): boolean {
  if (process.platform !== 'win32') return false

  try {
    execSync('wsl -- which lightpanda', { stdio: 'pipe', timeout: 3000 })

    return true
  } catch {
    return false
  }
}

function startWslBinary (port: number): ChildProcess {
  debug('starting ZenPanda via WSL on port %d', port)

  return spawn('wsl', ['--', 'lightpanda', 'serve', '--port', String(port)], { stdio: 'ignore' })
}

/**
 * Ensure ZenPanda is reachable. If not, auto-start via Docker/native/WSL.
 * Returns a cleanup function to stop the managed instance (if any).
 */
export async function ensureZenPandaRunning (rawConfig: Record<string, unknown> = {}): Promise<() => Promise<void>> {
  const cfg = getConfig(rawConfig)
  const { host, port, autoStart, dockerImage, stopAfterRun } = cfg

  debug('ensuring ZenPanda at %s:%d (autoStart=%s)', host, port, autoStart)

  const already = await probeEndpoint(host, port)

  if (already) {
    debug('ZenPanda already running at %s:%d', host, port)

    return async () => { /* nothing to clean up — we didn't start it */ }
  }

  if (!autoStart) {
    throw new Error(
      `ZenPanda is not running at ${host}:${port} and autoStart is disabled.\n` +
      `Start ZenPanda manually: zenpanda serve --port ${port}`,
    )
  }

  // Prefer Docker, fall back to native, then WSL
  const useDocker = cfg.docker !== false && dockerAvailable()

  if (useDocker) {
    if (!dockerContainerRunning(CONTAINER_NAME)) {
      startDockerContainer(dockerImage, host, port)
      managedContainerName = CONTAINER_NAME
    } else {
      debug('Docker container %s already running', CONTAINER_NAME)
    }
  } else if (nativeBinaryAvailable()) {
    managedChildProcess = startNativeBinary(port)
  } else if (wslBinaryAvailable()) {
    managedChildProcess = startWslBinary(port)
  } else {
    throw new Error(
      `ZenPanda is not running at ${host}:${port} and no start method is available.\n` +
      `Options:\n` +
      `  1. Docker: docker run -d -p ${port}:${port} ${dockerImage}\n` +
      `  2. Native: install lightpanda/zenpanda binary and run: zenpanda serve --port ${port}\n` +
      `  3. WSL (Windows): wsl -- lightpanda serve --port ${port}`,
    )
  }

  debug('waiting for ZenPanda to become ready at %s:%d', host, port)
  await waitForEndpoint(host, port)
  debug('ZenPanda is ready')

  return async () => {
    if (!stopAfterRun) {
      debug('stopAfterRun=false, leaving ZenPanda running')

      return
    }

    if (managedContainerName) {
      debug('stopping Docker container %s', managedContainerName)
      try {
        execSync(`docker stop ${managedContainerName}`, { stdio: 'pipe' })
      } catch { /* ignore */ }

      managedContainerName = null
    }

    if (managedChildProcess) {
      debug('killing ZenPanda child process')
      managedChildProcess.kill('SIGTERM')
      managedChildProcess = null
    }
  }
}
