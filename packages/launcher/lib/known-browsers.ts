import type { Browser } from '@packages/types'

/** ZenPanda is the sole supported browser. Detected via its CDP HTTP endpoint, not a binary. */
export const knownBrowsers: Browser[] = [
  {
    name: 'zenpanda',
    family: 'zenpanda',
    channel: 'stable',
    displayName: 'ZenPanda',
    versionRegex: /^(\S+)$/m,
    binary: 'zenpanda',
  },
]
