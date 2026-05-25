const { defineConfig } = require('cypress')

module.exports = defineConfig({
  e2e: {
    supportFile: 'cypress/support/e2e.js',
    // ZenPanda endpoint — override via ZENPANDA_HOST / ZENPANDA_PORT env vars
    setupNodeEvents (on, config) {
      // Register ZenPanda as a browser when it's reachable.
      // In CI, skip if env var SKIP_ZENPANDA is set (ZenPanda not available).
      if (!process.env.SKIP_ZENPANDA) {
        const host = process.env.ZENPANDA_HOST || '127.0.0.1'
        const port = Number(process.env.ZENPANDA_PORT || 9222)

        config.browsers = config.browsers || []

        const alreadyAdded = config.browsers.some((b) => b.name === 'zenpanda')

        if (!alreadyAdded) {
          config.browsers.push({
            name: 'zenpanda',
            family: 'zenpanda',
            channel: 'stable',
            displayName: 'ZenPanda',
            version: '0.0.0',
            majorVersion: 0,
            path: `http://${host}:${port}`,
          })
        }
      }

      return config
    },
  },
})
