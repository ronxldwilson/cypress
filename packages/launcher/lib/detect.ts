import Bluebird from 'bluebird'
import http from 'http'
import { knownBrowsers } from './known-browsers'
import Debug from 'debug'
import type { Browser, FoundBrowser } from '@packages/types'
import { notDetectedAtPathErr } from './errors'

const debug = Debug('cypress:launcher:detect')

export const getMajorVersion = (version: string): string => {
  return version.split('.')[0]
}

const ZENPANDA_DEFAULT_HOST = '127.0.0.1'
const ZENPANDA_DEFAULT_PORT = 9222

/**
 * Probe a running ZenPanda instance via its /json/version HTTP endpoint.
 * ZENPANDA_HOST / ZENPANDA_PORT env vars override defaults.
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

/** Detect all known browsers (ZenPanda only). */
export const detect = (goalBrowsers?: Browser[]): Bluebird<FoundBrowser[]> => {
  const browsers = goalBrowsers || knownBrowsers

  debug('detecting browsers %o', browsers)

  return Bluebird.map(browsers, (browser) => detectZenPanda(browser))
  .then((results) => results.filter(Boolean) as FoundBrowser[])
}

/**
 * Detect a browser by path/URL.
 * For ZenPanda, path can be an HTTP URL: http://host:port
 */
export const detectByPath = (
  path: string,
  goalBrowsers?: Browser[],
): Promise<FoundBrowser> => {
  // ZenPanda path is an HTTP endpoint — detect via network probe
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      const url = new URL(path)
      const host = url.hostname
      const port = Number(url.port) || ZENPANDA_DEFAULT_PORT

      return new Promise((resolve, reject) => {
        const req = http.get(
          { host, port, path: '/json/version', timeout: 3000 },
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

                resolve({
                  name: 'zenpanda',
                  family: 'zenpanda',
                  channel: 'stable',
                  displayName: 'ZenPanda',
                  version: cleanVersion,
                  majorVersion: cleanVersion.split('.')[0],
                  path,
                  custom: true,
                })
              } catch {
                reject(notDetectedAtPathErr(`Could not parse ZenPanda /json/version response from ${path}`))
              }
            })
          },
        )

        req.on('error', (err) => reject(notDetectedAtPathErr(err.message)))
        req.on('timeout', () => {
          req.destroy()
          reject(notDetectedAtPathErr(`Timed out connecting to ZenPanda at ${path}`))
        })
      })
    } catch {
      return Promise.reject(notDetectedAtPathErr(`Invalid ZenPanda URL: ${path}`))
    }
  }

  return Promise.reject(
    notDetectedAtPathErr(
      `ZenPanda-only mode: path must be an HTTP URL (e.g. http://127.0.0.1:9222), got: ${path}`,
    ),
  )
}
