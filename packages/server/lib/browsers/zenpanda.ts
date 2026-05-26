/**
 * ZenPanda browser launcher for Cypress.
 *
 * ZenPanda (https://github.com/lightpanda-io/browser fork) is a multi-tenant
 * headless browser that speaks the Chrome DevTools Protocol (CDP) and runs as a
 * persistent server process. Unlike Chrome or Firefox, Cypress does NOT launch
 * ZenPanda — it connects to an already-running ZenPanda CDP server.
 *
 * Configuration (environment variables):
 *   ZENPANDA_HOST         — ZenPanda server host (default: 127.0.0.1)
 *   ZENPANDA_PORT         — ZenPanda server port (default: 9222)
 *   ZENPANDA_RUNNER_HOST  — Host the browser uses to reach Cypress server
 *                           (default: auto-detected; use "host.docker.internal"
 *                            when ZenPanda runs in a Docker bridge container)
 */

import { EventEmitter } from 'events'
import { execSync } from 'child_process'
import Debug from 'debug'
import { BrowserCriClient } from './browser-cri-client'
import { CdpAutomation } from './cdp_automation'
import { _connectAsync, _getDelayMsForRetry } from './protocol'
import utils from './utils'
import { ensureZenPandaRunning } from './zenpanda-lifecycle'
import type { Browser, BrowserInstance } from './types'
import type { Automation } from '../automation'
import type { BrowserLaunchOpts, BrowserNewTabOpts, ProtocolManagerShape, CyPromptManagerShape, StudioManagerShape } from '@packages/types'
import type { CDPSocketServer } from '@packages/socket'
import type { CriClient } from './cri-client'

const debug = Debug('cypress:server:browsers:zenpanda')

const ZENPANDA_DEFAULT_HOST = '127.0.0.1'
const ZENPANDA_DEFAULT_PORT = 9222

let browserCriClient: BrowserCriClient | undefined
let lifecycleCleanup: (() => Promise<void>) | undefined
let _cachedRunnerHost: string | null = null

/**
 * Detect if ZenPanda is running inside a Docker container with bridge networking,
 * and if so return `host.docker.internal` as the host ZenPanda should use to
 * reach the Cypress server. Returns null if no rewrite is needed.
 *
 * Priority:
 *   1. ZENPANDA_RUNNER_HOST env var (explicit override)
 *   2. Docker bridge auto-detect: if a container maps host port 9222, use host.docker.internal
 *   3. null (no rewrite)
 */
function _detectRunnerHost (zenHost: string, zenPort: number): string | null {
  if (process.env.ZENPANDA_RUNNER_HOST) {
    return process.env.ZENPANDA_RUNNER_HOST
  }

  // Only auto-detect when ZenPanda is on localhost
  if (zenHost !== '127.0.0.1' && zenHost !== 'localhost') {
    return null
  }

  try {
    const out = execSync(
      `docker ps --filter "publish=${zenPort}" --format "{{.Names}}"`,
      { stdio: 'pipe', timeout: 2000 },
    ).toString().trim()

    if (out) {
      debug('ZenPanda is in Docker container "%s" — using host.docker.internal for runner URL', out)

      return 'host.docker.internal'
    }
  } catch {
    // docker not available or no containers
  }

  return null
}

/**
 * Replace the origin (scheme+host+port) of `url` with the origin of `newOriginUrl`.
 * Used to redirect browser from baseUrl-based runner URL to proxyUrl-based URL.
 */
function _swapOrigin (url: string, newOriginUrl: string): string {
  try {
    const parsed = new URL(url)
    const newOrigin = new URL(newOriginUrl)

    parsed.hostname = newOrigin.hostname
    parsed.port = newOrigin.port
    parsed.protocol = newOrigin.protocol

    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * Rewrite a Cypress runner URL so ZenPanda (potentially in Docker) can reach
 * the Cypress server. Replaces `127.0.0.1` / `localhost` with the Docker bridge
 * host when needed.
 */
function _rewriteRunnerUrl (url: string, zenHost: string, zenPort: number): string {
  const runnerHost = _detectRunnerHost(zenHost, zenPort)

  if (!runnerHost) return url

  // Replace 127.0.0.1 or localhost (preserving port) with the bridge host
  return url.replace(/\b(127\.0\.0\.1|localhost)\b/g, runnerHost)
}

function getZenPandaEndpoint (browser: Browser): { host: string, port: number } {
  // browser.path is set to http://<host>:<port> during detection (see launcher/detect.ts)
  if (browser.path && browser.path.startsWith('http://')) {
    try {
      const url = new URL(browser.path)

      return {
        host: url.hostname || ZENPANDA_DEFAULT_HOST,
        port: Number(url.port) || ZENPANDA_DEFAULT_PORT,
      }
    } catch {
      // fall through to env-var / defaults
    }
  }

  return {
    host: process.env.ZENPANDA_HOST || ZENPANDA_DEFAULT_HOST,
    port: Number(process.env.ZENPANDA_PORT || ZENPANDA_DEFAULT_PORT),
  }
}

function _getBrowserCriClient () {
  if (!browserCriClient) throw new Error('Missing browserCriClient in ZenPanda launcher')

  return browserCriClient
}

/**
 * Create a page-level CDP client for ZenPanda using flat session multiplexing.
 * ZenPanda doesn't expose targets via /json/list, so we can't create a separate
 * WebSocket per target. Instead we use Target.attachToTarget on the browser-level
 * WebSocket and communicate with the page using a sessionId.
 */
async function _createZenPandaPageClient (
  browserCriClient: BrowserCriClient,
  targetId: string,
  onAsynchronousError: (err: Error) => void,
): Promise<CriClient> {
  const rawClient = browserCriClient.rawBrowserClient

  // Attach to the target to get a session
  const { sessionId } = await rawClient.send('Target.attachToTarget', { targetId, flatten: true })

  debug('ZenPanda page session created %o', { targetId, sessionId })

  // Return the raw browser client scoped to this session.
  // We create a thin proxy so callers get a CriClient-like object bound to sessionId.
  const boundSend = (command: any, params?: any) => rawClient.send(command, params, sessionId)
  const boundOn = (event: any, cb: any) => rawClient.on(`${event}.${sessionId}` as any, cb)
  const boundOff = (event: any, cb: any) => rawClient.off(`${event}.${sessionId}` as any, cb)

  // Construct a minimal CriClient-compatible proxy object
  const proxy = {
    targetId,
    send: boundSend,
    on: boundOn,
    off: boundOff,
    clone: async () => proxy,
    close: async () => {},
    get closed () { return false },
    get connected () { return true },
    get crashed () { return false },
    get ws () { return rawClient.ws },
  }

  return proxy as unknown as CriClient
}

async function _setAutomation (
  pageCriClient: CriClient,
  automation: Automation,
  resetBrowserTargets: BrowserCriClient['resetBrowserTargets'],
  options: BrowserLaunchOpts | BrowserNewTabOpts,
) {
  const cdpAutomation = await CdpAutomation.create(
    pageCriClient.send,
    pageCriClient.on,
    pageCriClient.off,
    resetBrowserTargets,
    automation,
    (options as BrowserLaunchOpts).protocolManager,
  )

  automation.use(cdpAutomation)

  return cdpAutomation
}

export function clearInstanceState () {
  debug('clearing ZenPanda instance state')
  browserCriClient?.close().catch(() => {})
  browserCriClient = undefined
  lifecycleCleanup?.().catch(() => {})
  lifecycleCleanup = undefined
  _cachedRunnerHost = null
}

export async function connectToExisting (
  browser: Browser,
  options: BrowserLaunchOpts,
  automation: Automation,
  cdpSocketServer?: CDPSocketServer,
) {
  const { host, port } = getZenPandaEndpoint(browser)

  debug('connecting to existing ZenPanda instance %o', { host, port })

  if (!options.onError) throw new Error('Missing onError in connectToExisting')

  browserCriClient = await BrowserCriClient.create({
    hosts: [host],
    port,
    browserName: browser.displayName,
    onAsynchronousError: options.onError,
    fullyManageTabs: false,
    onServiceWorkerClientEvent: automation.onServiceWorkerClientEvent,
  })

  if (!options.url) throw new Error('Missing url in connectToExisting')

  const { targetId } = await browserCriClient.rawBrowserClient.send('Target.createTarget', { url: 'about:blank' })
  const pageCriClient = await _createZenPandaPageClient(browserCriClient, targetId, options.onError!)

  await cdpSocketServer?.attachCDPClient(pageCriClient)
  await _setAutomation(pageCriClient, automation, browserCriClient.resetBrowserTargets, options)
}

export async function connectToNewSpec (
  _browser: Browser,
  options: BrowserNewTabOpts,
  automation: Automation,
  cdpSocketServer?: CDPSocketServer,
) {
  debug('connecting to new ZenPanda tab %o', { url: options.url })

  const client = _getBrowserCriClient()
  const pageCriClient = client.currentlyAttachedTarget

  if (!pageCriClient) throw new Error('Missing pageCriClient in connectToNewSpec')
  if (!options.url) throw new Error('Missing url in connectToNewSpec')

  await connectProtocolToBrowser({ protocolManager: options.protocolManager })
  await cdpSocketServer?.attachCDPClient(pageCriClient)

  const cdpAutomation = await _setAutomation(pageCriClient, automation, client.resetBrowserTargets, options)

  await pageCriClient.send('Page.enable')
  await options.onInitializeNewBrowserTab?.()

  await Promise.all([
    utils.initializeCDP(pageCriClient, automation),
  ])

  const specUrl = _cachedRunnerHost
    ? options.url.replace(/\b(127\.0\.0\.1|localhost)\b/g, _cachedRunnerHost)
    : options.url

  await pageCriClient.send('Page.navigate', { url: specUrl })
  cdpAutomation._listenForFrameTreeChanges(pageCriClient)
}

export async function connectProtocolToBrowser (options: { protocolManager?: ProtocolManagerShape }) {
  const client = _getBrowserCriClient()

  if (!client.currentlyAttachedTarget) throw new Error('Missing pageCriClient in connectProtocolToBrowser')

  if (!client.currentlyAttachedProtocolTarget) {
    client.currentlyAttachedProtocolTarget = await client.currentlyAttachedTarget.clone()
  }

  await options.protocolManager?.connectToBrowser(client.currentlyAttachedProtocolTarget)
}

export async function connectCyPromptToBrowser (options: { cyPromptManager?: CyPromptManagerShape }) {
  const client = _getBrowserCriClient()

  if (!client.currentlyAttachedTarget) throw new Error('Missing pageCriClient in connectCyPromptToBrowser')

  if (!client.currentlyAttachedCyPromptTarget) {
    client.currentlyAttachedCyPromptTarget = await client.currentlyAttachedTarget.clone()
  }

  await options.cyPromptManager?.connectToBrowser(client.currentlyAttachedCyPromptTarget)
}

export async function connectStudioToBrowser (options: { studioManager?: StudioManagerShape }) {
  const client = _getBrowserCriClient()

  if (!client.currentlyAttachedTarget) throw new Error('Missing pageCriClient in connectStudioToBrowser')

  if (!client.currentlyAttachedStudioTarget) {
    client.currentlyAttachedStudioTarget = await client.currentlyAttachedTarget.clone()
  }

  await options.studioManager?.connectToBrowser(client.currentlyAttachedStudioTarget)
}

export async function closeProtocolConnection () {
  const client = _getBrowserCriClient()

  if (client.currentlyAttachedProtocolTarget) {
    await client.currentlyAttachedProtocolTarget.close()
    client.currentlyAttachedProtocolTarget = undefined
  }
}

export async function closeExtraTargets () {
  return browserCriClient?.closeExtraTargets()
}

/**
 * "Open" ZenPanda — since ZenPanda is a persistent server, this connects to
 * the already-running instance rather than spawning a new process.
 *
 * Returns a synthetic BrowserInstance whose kill() disconnects the CDP client.
 */
export async function open (
  browser: Browser,
  url: string,
  options: BrowserLaunchOpts,
  automation: Automation,
  cdpSocketServer?: CDPSocketServer,
): Promise<BrowserInstance> {
  const { host, port } = getZenPandaEndpoint(browser)

  debug('connecting to ZenPanda at %s:%d for url %s', host, port, url)

  if (!options.onError) throw new Error('Missing onError in zenpanda#open')

  // Auto-start ZenPanda via Docker/native/WSL if not already running
  const zenConfig = (options as any).zenpanda || {}

  lifecycleCleanup = await ensureZenPandaRunning({ host, port, ...zenConfig })

  // Verify ZenPanda is reachable before attempting CDP connection
  await _connectAsync({ host, port, getDelayMsForRetry: (i) => _getDelayMsForRetry(i, browser.displayName) }).catch((err) => {
    err.message = [
      `Could not connect to ZenPanda at ${host}:${port}.`,
      `Make sure ZenPanda is running before starting Cypress.`,
      `Start ZenPanda: zenpanda serve --port ${port}`,
      `Original error: ${err.message}`,
    ].join('\n')
    throw err
  })

  browserCriClient = await BrowserCriClient.create({
    hosts: [host],
    port,
    browserName: browser.displayName,
    onAsynchronousError: options.onError,
    fullyManageTabs: true,
    onServiceWorkerClientEvent: automation.onServiceWorkerClientEvent,
  })

  debug('ZenPanda BrowserCriClient created')

  // Create a new target and attach via session (ZenPanda doesn't expose targets in /json/list)
  const { targetId } = await browserCriClient.rawBrowserClient.send('Target.createTarget', { url: 'about:blank' })

  debug('ZenPanda target created %o', { targetId })

  const pageCriClient = await _createZenPandaPageClient(browserCriClient, targetId, options.onError!)

  await cdpSocketServer?.attachCDPClient(pageCriClient)

  const cdpAutomation = await _setAutomation(pageCriClient, automation, browserCriClient.resetBrowserTargets, options)

  await pageCriClient.send('Page.enable')

  await options['onInitializeNewBrowserTab']?.()

  await Promise.all([
    utils.initializeCDP(pageCriClient, automation).catch((err) => {
      debug('initializeCDP error (non-fatal for ZenPanda): %s', err.message)
    }),
  ])

  // Cache runner host for subsequent spec navigations (connectToNewSpec)
  _cachedRunnerHost = _detectRunnerHost(host, port)

  // ZenPanda is not launched with --proxy-server so it cannot route through
  // Cypress's HTTP proxy automatically. Instead we navigate it directly to
  // the Cypress proxy server (proxyUrl) rather than the app's baseUrl.
  // The proxyUrl is e.g. http://localhost:54392 and the url is
  // http://localhost:5173/__/#/specs/runner?file=... — we swap the origin.
  const proxyUrl: string = (options as any).proxyUrl || url
  const runnerUrl = _rewriteRunnerUrl(
    _swapOrigin(url, proxyUrl),
    host,
    port,
  )

  debug('navigating ZenPanda to %s (original: %s, runnerHost: %s)', runnerUrl, url, _cachedRunnerHost)
  await pageCriClient.send('Page.navigate', { url: runnerUrl })

  await cdpAutomation._handlePausedRequests(pageCriClient)
  cdpAutomation._listenForFrameTreeChanges(pageCriClient)

  await utils.executeAfterBrowserLaunch(browser, {
    webSocketDebuggerUrl: browserCriClient.getWebSocketDebuggerUrl(),
  })

  // Return a synthetic BrowserInstance — ZenPanda keeps running after tests;
  // kill() only disconnects Cypress's CDP session.
  class ZenPandaInstance extends EventEmitter implements BrowserInstance {
    pid = -1 // ZenPanda is an external process; no PID available here

    async kill () {
      debug('disconnecting from ZenPanda')
      clearInstanceState()
      this.emit('exit', 0, null)
    }
  }

  return new ZenPandaInstance()
}
