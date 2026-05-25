import Bluebird from 'bluebird'
import _, { compact, extend, find } from 'lodash'
import os from 'os'
import http from 'http'
import { removeDuplicateBrowsers } from '@packages/data-context/src/sources/BrowserDataSource'
import { knownBrowsers } from './known-browsers'
import * as darwinHelper from './darwin'
import { notDetectedAtPathErr } from './errors'
import * as linuxHelper from './linux'
import Debug from 'debug'
import type {
  Browser,
  BrowserValidator,
  DetectedBrowser,
  FoundBrowser,
} from '@packages/types'
import type {
  NotDetectedAtPathError,
  NotInstalledError, PathData,
} from './types'
import * as windowsHelper from './windows'

const debug = Debug('cypress:launcher:detect')
const debugVerbose = Debug('cypress-verbose:launcher:detect')

type HasVersion = Omit<Partial<FoundBrowser>, 'version' | 'name'> & {
  version: string
  name: string
}

export const getMajorVersion = (version: string): string => {
  return version.split('.')[0]
}

// Determines if found browser is supported by Cypress. If found to be
// unsupported, the browser will be unavailable for selection and
// will present the determined warning message to the user.
const validateCypressSupport = (validator: BrowserValidator | undefined, browser: FoundBrowser, platform: NodeJS.Platform) => {
  if (!validator) {
    return
  }

  const { isSupported, warningMessage } = validator(browser, platform)

  if (isSupported) {
    return
  }

  browser.unsupportedVersion = true
  browser.warning = warningMessage
}

type PlatformHelper = {
  detect: (browser: Browser) => Promise<DetectedBrowser>
  getVersionString: (path: string) => Promise<string>
  getVersionNumber: (path: string, browser: Browser) => string
  getPathData: (path: string) => PathData
}

type Helpers = {
  [index: string]: PlatformHelper
}

const helpers: Helpers = {
  darwin: darwinHelper,
  linux: linuxHelper,
  win32: windowsHelper,
}

function getHelper (platform?: NodeJS.Platform): PlatformHelper {
  const helper = helpers[platform || os.platform()]

  if (!helper) {
    throw Error(`Could not find helper for ${platform}`)
  }

  return helper
}

function lookup (
  platform: NodeJS.Platform,
  browser: Browser,
): Promise<DetectedBrowser> {
  const helper = getHelper(platform)

  if (!helper) {
    throw new Error(`Cannot lookup browser ${browser.name} on ${platform}`)
  }

  return helper.detect(browser)
}

/**
 * Try to detect a single browser definition, which may dispatch multiple `checkOneBrowser` calls,
 * one for each binary. If Windows is detected, only one `checkOneBrowser` will be called, because
 * we don't use the `binary` field on Windows.
 *
 * ZenPanda is detected via its CDP HTTP endpoint instead of the filesystem.
 */
function checkBrowser (browser: Browser): Bluebird<(boolean | HasVersion)[]> {
  if (browser.family === 'zenpanda') {
    return Bluebird.resolve(detectZenPanda(browser)).then((result) => [result])
  }

  if (Array.isArray(browser.binary) && os.platform() !== 'win32') {
    return Bluebird.map(browser.binary, (binary: string) => {
      return checkOneBrowser(extend({}, browser, { binary }))
    })
  }

  return Bluebird.map([browser], checkOneBrowser)
}

function checkOneBrowser (browser: Browser): Promise<boolean | HasVersion> {
  const platform = os.platform()
  const pickBrowserProps = [
    'name',
    'family',
    'channel',
    'displayName',
    'type',
    'version',
    'path',
    'profilePath',
    'custom',
    'warning',
    'info',
    'unsupportedVersion',
  ] as const

  const failed = (err: NotInstalledError) => {
    if (err.notInstalled) {
      debugVerbose('browser %s not installed', browser.name)

      return false
    }

    throw err
  }

  return lookup(platform, browser)
  .then((val) => ({ ...browser, ...val }))
  .then((val) => _.pick(val, pickBrowserProps) as FoundBrowser)
  .then((foundBrowser) => {
    foundBrowser.majorVersion = getMajorVersion(foundBrowser.version)

    validateCypressSupport(browser.validator, foundBrowser, platform)

    return foundBrowser
  })
  .catch(failed)
}

const ZENPANDA_DEFAULT_HOST = '127.0.0.1'
const ZENPANDA_DEFAULT_PORT = 9222

/**
 * Attempt to discover a running ZenPanda instance by hitting its /json/version HTTP endpoint.
 * Returns a FoundBrowser if ZenPanda is reachable, false otherwise.
 */
function detectZenPanda (browser: Browser): Promise<false | FoundBrowser> {
  const host = process.env.ZENPANDA_HOST || ZENPANDA_DEFAULT_HOST
  const port = Number(process.env.ZENPANDA_PORT || ZENPANDA_DEFAULT_PORT)

  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: '/json/version', timeout: 2000 },
      (res) => {
        let body = ''

        res.on('data', (chunk) => {
          body += chunk
        })

        res.on('end', () => {
          try {
            const info = JSON.parse(body)
            const version: string = info['Browser'] || info['Version'] || '0.0.0'
            const cleanVersion = version.replace(/[^0-9.]/g, '') || '0.0.0'

            const foundBrowser: FoundBrowser = {
              name: browser.name,
              family: browser.family,
              channel: browser.channel,
              displayName: browser.displayName,
              version: cleanVersion,
              majorVersion: cleanVersion.split('.')[0],
              // ZenPanda path encodes the CDP WebSocket endpoint so the launcher
              // knows how to connect without re-detecting at launch time.
              path: `http://${host}:${port}`,
            }

            debug('detected ZenPanda %o', foundBrowser)
            resolve(foundBrowser)
          } catch {
            resolve(false)
          }
        })
      },
    )

    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** returns list of detected browsers */
export const detect = (goalBrowsers?: Browser[]): Bluebird<FoundBrowser[]> => {
  // we can detect same browser under different aliases
  // tell them apart by the name and the version property
  if (!goalBrowsers) {
    goalBrowsers = knownBrowsers
  }

  const compactFalse = (browsers: any[]) => {
    return compact(browsers) as FoundBrowser[]
  }

  debug('detecting if the following browsers are present %o', goalBrowsers)

  return Bluebird.mapSeries(goalBrowsers, checkBrowser)
  .then((val) => _.flatten(val))
  .then(compactFalse)
  .then(removeDuplicateBrowsers)
}

export const detectByPath = (
  path: string,
  goalBrowsers?: Browser[],
): Promise<FoundBrowser> => {
  if (!goalBrowsers) {
    goalBrowsers = knownBrowsers
  }

  const helper = getHelper()

  const detectBrowserByVersionString = (stdout: string): Browser | undefined => {
    return find(goalBrowsers, (goalBrowser: Browser) => {
      return goalBrowser.versionRegex.test(stdout)
    })
  }

  const detectBrowserFromKey = (browserKey): Browser | undefined => {
    return find(goalBrowsers, (goalBrowser) => {
      return (
        goalBrowser.name === browserKey ||
        goalBrowser.displayName === browserKey ||
        goalBrowser.binary.indexOf(browserKey) > -1
      )
    })
  }

  const setCustomBrowserData = (browser: Browser, path: string, versionStr: string): FoundBrowser => {
    const version = helper.getVersionNumber(versionStr, browser)

    const parsedBrowser = extend({}, browser, {
      name: browser.name,
      displayName: `Custom ${browser.displayName}`,
      info: `Loaded from ${path}`,
      custom: true,
      path,
      version,
      majorVersion: getMajorVersion(version),
    }) as FoundBrowser

    validateCypressSupport(browser.validator, parsedBrowser, os.platform())

    return parsedBrowser
  }

  const pathData = helper.getPathData(path)

  return helper.getVersionString(pathData.path)
  .then((version) => {
    let browser

    if (pathData.browserKey) {
      browser = detectBrowserFromKey(pathData.browserKey)
    }

    if (!browser) {
      browser = detectBrowserByVersionString(version)
    }

    if (!browser) {
      throw notDetectedAtPathErr(`Unable to find browser with path ${path}`)
    }

    return setCustomBrowserData(browser, pathData.path, version)
  })
  .catch((err: NotDetectedAtPathError) => {
    if (err.notDetectedAtPath) {
      throw err
    }

    throw notDetectedAtPathErr(err.message)
  })
}
