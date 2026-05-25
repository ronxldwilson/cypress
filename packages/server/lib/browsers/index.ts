import _ from 'lodash'
import Bluebird from 'bluebird'
import Debug from 'debug'
import utils from './utils'
import * as errors from '../errors'
import { BROWSER_FAMILY, BrowserLaunchOpts, BrowserNewTabOpts, FoundBrowser, ProtocolManagerShape, CyPromptManagerShape, StudioManagerShape } from '@packages/types'
import type { Browser, BrowserInstance, BrowserLauncher } from './types'
import type { Automation } from '../automation'
import type { DataContext } from '@packages/data-context'
import type { CDPSocketServer } from '@packages/socket'

const debug = Debug('cypress:server:browsers')
const isBrowserFamily = (browser: string) => BROWSER_FAMILY.includes(browser)

let instance: BrowserInstance | null = null
let launchAttempt = 0

interface KillOptions {
  instance?: BrowserInstance
  isProcessExit?: boolean
  nullOut?: boolean
  unbind?: boolean
  isOrphanedBrowserProcess?: boolean
}

const kill = (options: KillOptions = {}) => {
  options = _.defaults({}, options, {
    instance,
    isProcessExit: false,
    isOrphanedBrowserProcess: false,
    unbind: true,
    nullOut: true,
  })

  const instanceToKill = options.instance

  if (!instanceToKill) {
    debug('browsers.kill called with no active instance')

    return Promise.resolve()
  }

  if (options.nullOut) {
    instance = null
  }

  return new Promise<void>((resolve) => {
    instanceToKill.once('exit', () => {
      if (options.unbind) {
        instanceToKill.removeAllListeners()
      }

      debug('ZenPanda session ended')

      resolve()
    })

    debug('ending ZenPanda CDP session')

    instanceToKill.isProcessExit = options.isProcessExit
    instanceToKill.isOrphanedBrowserProcess = options.isOrphanedBrowserProcess
    instanceToKill.kill()
  })
}

function getBrowserLauncher (browser: Browser, browsers: FoundBrowser[]): BrowserLauncher {
  debug('getBrowserLauncher %o', { browser })

  if (browser.family === 'zenpanda') return require('./zenpanda')

  return utils.throwBrowserNotFound(browser.name, browsers)
}

process.once('exit', () => kill({ isProcessExit: true }))

const browsers = {
  ensureAndGetByNameOrPath: utils.ensureAndGetByNameOrPath,

  isBrowserFamily,

  removeOldProfiles: utils.removeOldProfiles,

  get: utils.getBrowsers,

  close: kill,

  formatBrowsersToOptions: utils.formatBrowsersToOptions,

  // ZenPanda is headless-only; focus is a no-op
  setFocus: () => Promise.resolve(),

  _setInstance (_instance: BrowserInstance) {
    instance = _instance
  },

  getBrowserInstance () {
    return instance
  },

  async connectToExisting (browser: Browser, options: BrowserLaunchOpts, automation: Automation, cdpSocketServer?: CDPSocketServer): Promise<BrowserInstance | null> {
    const browserLauncher = getBrowserLauncher(browser, options.browsers)

    await browserLauncher.connectToExisting(browser, options, automation, cdpSocketServer)

    return this.getBrowserInstance()
  },

  async connectProtocolToBrowser (options: { browser: Browser, foundBrowsers?: FoundBrowser[], protocolManager?: ProtocolManagerShape }) {
    const browserLauncher = getBrowserLauncher(options.browser, options.foundBrowsers || [])

    await browserLauncher.connectProtocolToBrowser(options)
  },

  async connectCyPromptToBrowser (options: { browser: Browser, foundBrowsers?: FoundBrowser[], cyPromptManager?: CyPromptManagerShape }) {
    const browserLauncher = getBrowserLauncher(options.browser, options.foundBrowsers || [])

    await browserLauncher.connectCyPromptToBrowser(options)
  },

  async connectStudioToBrowser (options: { browser: Browser, foundBrowsers?: FoundBrowser[], studioManager?: StudioManagerShape }) {
    const browserLauncher = getBrowserLauncher(options.browser, options.foundBrowsers || [])

    await browserLauncher.connectStudioToBrowser(options)
  },

  async closeProtocolConnection (options: { browser: Browser, foundBrowsers?: FoundBrowser[] }) {
    const browserLauncher = getBrowserLauncher(options.browser, options.foundBrowsers || [])

    await browserLauncher.closeProtocolConnection()
  },

  async connectToNewSpec (browser: Browser, options: BrowserNewTabOpts, automation: Automation, cdpSocketServer?: CDPSocketServer): Promise<BrowserInstance | null> {
    const browserLauncher = getBrowserLauncher(browser, options.browsers)

    await browserLauncher.connectToNewSpec(browser, options, automation, cdpSocketServer)

    return this.getBrowserInstance()
  },

  async open (browser: Browser, options: BrowserLaunchOpts, automation: Automation, ctx: DataContext): Promise<BrowserInstance | null> {
    launchAttempt++
    const thisLaunchAttempt = launchAttempt

    await kill()

    _.defaults(options, {
      onBrowserOpen () {},
      onBrowserClose () {},
    })

    ctx.actions.app.setBrowserStatus('opening')

    const browserLauncher = getBrowserLauncher(browser, options.browsers)

    if (!options.url) throw new Error('Missing url in browsers.open')

    debug('opening ZenPanda session %o', browser)

    const _instance = await browserLauncher.open(browser, options.url, options, automation, ctx.coreData.servers.cdpSocketServer)

    debug(`ZenPanda session opened for launch ${thisLaunchAttempt}`)

    const isOrphanedBrowserProcess = thisLaunchAttempt !== launchAttempt

    if (isOrphanedBrowserProcess) {
      debug(`killing orphaned session ${thisLaunchAttempt}`)
      await kill({ instance: _instance, isOrphanedBrowserProcess, nullOut: false })

      return null
    }

    instance = _instance
    instance.browser = browser

    instance.once('exit', async (code, signal) => {
      ctx.coreData.didBrowserPreviouslyHaveUnexpectedExit = true

      debug('ZenPanda session exit %o', { code, signal })

      ctx.actions.app.setBrowserStatus('closed')
      if (!options.onBrowserClose) throw new Error('onBrowserClose did not exist')

      options.onBrowserClose()
      browserLauncher.clearInstanceState()
      instance = null

      if (code === null && ['SIGTRAP', 'SIGABRT'].includes(signal) || code === 2147483651 && signal === null) {
        const err = errors.get('BROWSER_CRASHED', browser.displayName, code, signal)

        if (!options.onError) {
          errors.log(err)
          throw new Error('Missing onError in attachListeners')
        }

        await options.onError(err)
      }
    })

    // ZenPanda is already running — no process startup delay needed
    await Bluebird.delay(200)

    if (instance === null) return null

    if (!options.onBrowserOpen) throw new Error('onBrowserOpen did not exist')

    options.onBrowserOpen()
    ctx.actions.app.setBrowserStatus('open')

    return instance
  },

  async closeExtraTargets () {
    if (!instance?.browser) return

    const browserLauncher = getBrowserLauncher(instance.browser, [])

    await browserLauncher.closeExtraTargets()
  },
} as const

export default browsers
