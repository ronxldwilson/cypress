/**
 * ZenPanda browser launcher for Cypress.
 *
 * ZenPanda (https://github.com/lightpanda-io/browser fork) is a multi-tenant
 * headless browser that speaks the Chrome DevTools Protocol (CDP) and runs as a
 * persistent server process. Unlike Chrome or Firefox, Cypress does NOT launch
 * ZenPanda — it connects to an already-running ZenPanda CDP server.
 *
 * Configuration (environment variables):
 *   ZENPANDA_HOST  — ZenPanda server host (default: 127.0.0.1)
 *   ZENPANDA_PORT  — ZenPanda server port (default: 9222)
 */

import { EventEmitter } from 'events'
import Debug from 'debug'
import { BrowserCriClient } from './browser-cri-client'
import { CdpAutomation } from './cdp_automation'
import { _connectAsync, _getDelayMsForRetry } from './protocol'
import utils from './utils'
import type { Browser, BrowserInstance } from './types'
import type { Automation } from '../automation'
import type { BrowserLaunchOpts, BrowserNewTabOpts, ProtocolManagerShape, CyPromptManagerShape, StudioManagerShape } from '@packages/types'
import type { CDPSocketServer } from '@packages/socket'
import type { CriClient } from './cri-client'

const debug = Debug('cypress:server:browsers:zenpanda')

const ZENPANDA_DEFAULT_HOST = '127.0.0.1'
const ZENPANDA_DEFAULT_PORT = 9222

let browserCriClient: BrowserCriClient | undefined

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

async function _setAutomation (
  pageCriClient: CriClient,
  automation: Automation,
  resetBrowserTargets: BrowserCriClient['resetBrowserTargets'],
  options: BrowserLaunchOpts | BrowserNewTabOpts,
) {
  const cdpAutomation = await CdpAutomation.create(
    pageCriClient.send.bind(pageCriClient),
    pageCriClient.on.bind(pageCriClient),
    pageCriClient.off.bind(pageCriClient),
    resetBrowserTargets,
    automation,
  )

  automation.use(cdpAutomation)

  return cdpAutomation
}

export function clearInstanceState () {
  debug('clearing ZenPanda instance state')
  browserCriClient?.close().catch(() => {})
  browserCriClient = undefined
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

  const pageCriClient = await browserCriClient.attachToTargetUrl(options.url)

  await cdpSocketServer?.attachCDPClient(pageCriClient)
  await _setAutomation(pageCriClient, automation, browserCriClient.resetBrowserTargets, options)
}

export async function connectToNewSpec (
  browser: Browser,
  options: BrowserNewTabOpts,
  automation: Automation,
  cdpSocketServer?: CDPSocketServer,
) {
  debug('connecting to new ZenPanda tab %o', { url: options.url })

  const client = _getBrowserCriClient()

  const pageCriClient = client.currentlyAttachedTarget

  if (!pageCriClient) throw new Error('Missing pageCriClient in connectToNewSpec')
  if (!options.url) throw new Error('Missing url in connectToNewSpec')

  await pageCriClient.send('Page.navigate', { url: 'about:blank' })
  const newPageCriClient = await client.attachToTargetUrl('about:blank')

  await cdpSocketServer?.attachCDPClient(newPageCriClient)

  await connectProtocolToBrowser({ protocolManager: options.protocolManager })
  await _setAutomation(newPageCriClient, automation, client.resetBrowserTargets, options)

  await newPageCriClient.send('Page.enable')
  await options.onInitializeNewBrowserTab?.()

  await Promise.all([
    utils.initializeCDP(newPageCriClient, automation),
  ])

  await newPageCriClient.send('Page.navigate', { url: options.url })
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

  // Navigate to a blank page first so we get a fresh target to attach to
  const pageCriClient = await browserCriClient.attachToTargetUrl('about:blank')

  await cdpSocketServer?.attachCDPClient(pageCriClient)

  const cdpAutomation = await _setAutomation(pageCriClient, automation, browserCriClient.resetBrowserTargets, options)

  await pageCriClient.send('Page.enable')

  await options['onInitializeNewBrowserTab']?.()

  await Promise.all([
    utils.initializeCDP(pageCriClient, automation),
  ])

  await pageCriClient.send('Page.navigate', { url })

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

  const instance = new ZenPandaInstance()

  browserCriClient.on('disconnect', () => {
    debug('ZenPanda CDP connection closed unexpectedly')
    instance.emit('exit', null, 'SIGTERM')
  })

  return instance
}
