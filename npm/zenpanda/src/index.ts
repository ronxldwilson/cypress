/**
 * @cypress/zenpanda
 *
 * Cypress plugin for running tests against ZenPanda — a multi-tenant,
 * low-memory headless browser that speaks the Chrome DevTools Protocol (CDP).
 *
 * ZenPanda: https://github.com/lightpanda-io/browser (Lightpanda fork)
 *
 * Unlike Chrome or Firefox, ZenPanda runs as a persistent server process.
 * Cypress connects to it via CDP WebSocket rather than launching it.
 *
 * Usage in cypress.config.ts:
 *
 *   import { defineConfig } from 'cypress'
 *   import { defineZenPandaConfig } from '@cypress/zenpanda'
 *
 *   export default defineConfig(defineZenPandaConfig({
 *     e2e: {
 *       baseUrl: 'http://localhost:3000',
 *     },
 *   }))
 *
 * Or to add ZenPanda alongside other browsers:
 *
 *   import { addZenPandaBrowser } from '@cypress/zenpanda'
 *
 *   export default defineConfig({
 *     e2e: {
 *       setupNodeEvents(on, config) {
 *         addZenPandaBrowser(on, config)
 *         return config
 *       },
 *     },
 *   })
 *
 * Environment variables (set before starting Cypress):
 *   ZENPANDA_HOST  — ZenPanda server host (default: 127.0.0.1)
 *   ZENPANDA_PORT  — ZenPanda server port (default: 9222)
 */

import http from 'http'
import Debug from 'debug'

const debug = Debug('cypress:zenpanda:plugin')

export const ZENPANDA_DEFAULT_HOST = '127.0.0.1'
export const ZENPANDA_DEFAULT_PORT = 9222

export interface ZenPandaOptions {
  /** ZenPanda server host. Defaults to ZENPANDA_HOST env var or 127.0.0.1 */
  host?: string
  /** ZenPanda server port. Defaults to ZENPANDA_PORT env var or 9222 */
  port?: number
}

export interface ZenPandaBrowserInfo {
  name: string
  family: string
  channel: string
  displayName: string
  version: string
  majorVersion: string
  path: string
}

/**
 * Probe a running ZenPanda instance and return its version information.
 * Resolves to null if ZenPanda is not reachable.
 */
export async function probeZenPanda (options: ZenPandaOptions = {}): Promise<ZenPandaBrowserInfo | null> {
  const host = options.host || process.env.ZENPANDA_HOST || ZENPANDA_DEFAULT_HOST
  const port = options.port || Number(process.env.ZENPANDA_PORT || ZENPANDA_DEFAULT_PORT)

  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: '/json/version', timeout: 3000 },
      (res) => {
        let body = ''

        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })

        res.on('end', () => {
          try {
            const info = JSON.parse(body)
            const rawVersion: string = info['Browser'] || info['Version'] || '0.0.0'
            const version = rawVersion.replace(/[^0-9.]/g, '') || '0.0.0'
            const majorVersion = version.split('.')[0]

            resolve({
              name: 'zenpanda',
              family: 'zenpanda',
              channel: 'stable',
              displayName: 'ZenPanda',
              version,
              majorVersion,
              path: `http://${host}:${port}`,
            })
          } catch {
            resolve(null)
          }
        })
      },
    )

    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * Inject a ZenPanda entry into the Cypress browser list via the
 * `before:browser:launch` setup hook.  Call this inside `setupNodeEvents`.
 *
 * @example
 *   setupNodeEvents(on, config) {
 *     addZenPandaBrowser(on, config)
 *     return config
 *   }
 */
export function addZenPandaBrowser (
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
  options: ZenPandaOptions = {},
) {
  const host = options.host || process.env.ZENPANDA_HOST || ZENPANDA_DEFAULT_HOST
  const port = options.port || Number(process.env.ZENPANDA_PORT || ZENPANDA_DEFAULT_PORT)
  const path = `http://${host}:${port}`

  // Avoid duplicates if called multiple times
  const alreadyAdded = (config.browsers || []).some((b) => b.name === 'zenpanda')

  if (!alreadyAdded) {
    (config.browsers || []).push({
      name: 'zenpanda',
      family: 'zenpanda' as any,
      channel: 'stable',
      displayName: 'ZenPanda',
      version: '0.0.0',
      majorVersion: 0 as any,
      path,
    })

    debug('added ZenPanda browser at %s', path)
  }
}

/**
 * Convenience wrapper that wires up ZenPanda detection and injects the browser
 * entry automatically. Merges with any existing `setupNodeEvents` you provide.
 *
 * @example
 *   export default defineConfig(defineZenPandaConfig({
 *     e2e: { baseUrl: 'http://localhost:3000' },
 *   }, { port: 9222 }))
 */
export function defineZenPandaConfig (
  cypressConfig: Cypress.ConfigOptions,
  options: ZenPandaOptions = {},
): Cypress.ConfigOptions {
  const originalSetupNodeEvents = cypressConfig.e2e?.setupNodeEvents

  return {
    ...cypressConfig,
    e2e: {
      ...cypressConfig.e2e,
      setupNodeEvents (on, config) {
        addZenPandaBrowser(on, config, options)

        if (originalSetupNodeEvents) {
          return originalSetupNodeEvents(on, config)
        }

        return config
      },
    },
  }
}

export default {
  defineZenPandaConfig,
  addZenPandaBrowser,
  probeZenPanda,
}
