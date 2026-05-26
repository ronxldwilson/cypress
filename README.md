# Zenpresso

Zenpresso — a stripped-down Cypress fork built for ZenPanda.

[ZenPanda](https://github.com/ronxldwilson/zenpanda) is a multi-tenant headless browser (Zig + V8) that speaks the Chrome DevTools Protocol (CDP). It runs as a persistent server — Zenpresso connects to it over a WebSocket instead of launching a new browser process per run.

## Why

- **Speed** — no per-run browser spawn; ZenPanda is already running
- **Scale** — multi-tenant; many Zenpresso workers can share one ZenPanda instance
- **Lean** — removed Chrome, Firefox, WebKit, Electron browser launchers; removed ffmpeg, geckodriver, playwright-webkit, and all framework-specific component-testing adapters

## Prerequisites

- [Bun](https://bun.sh)
- A running ZenPanda instance

```bash
# Start ZenPanda via Docker
docker run -d --name zenpanda -p 127.0.0.1:9222:9222 ronxldwilson/zenpanda:latest
```

Override the default host/port with env vars:

```bash
ZENPANDA_HOST=127.0.0.1
ZENPANDA_PORT=9222
```

## Quick start

```bash
# Install dependencies
bun install

# Verify ZenPanda is reachable
bun packages/launcher/test-zenpanda-detect.js

# Run the CDP smoke test (requires ZenPanda running)
bun packages/server/test-zenpanda-cdp.js

# Open Zenpresso (dev mode)
bun dev
```

## Configuring a project

Use the `@cypress/zenpanda` plugin to register ZenPanda as a browser:

```js
// cypress.config.js
const { defineConfig } = require('cypress')
const { addZenPandaBrowser } = require('@cypress/zenpanda')

module.exports = defineConfig({
  e2e: {
    setupNodeEvents (on, config) {
      return addZenPandaBrowser(config)
    },
  },
})
```

Run with:

```bash
bunx cypress run --browser zenpanda
```

## Monorepo structure (relevant packages)

| Path | Purpose |
|------|---------|
| `packages/server/lib/browsers/zenpanda.ts` | ZenPanda browser launcher — connects via CDP WebSocket |
| `packages/launcher/lib/detect.ts` | Detects ZenPanda via HTTP probe (`/json/version`) |
| `npm/zenpanda/` | `@cypress/zenpanda` plugin (adds ZenPanda browser + `probeZenPanda()`) |
| `system-tests/projects/zenpanda-configured/` | Example system-test project |
| `packages/launcher/test-zenpanda-detect.js` | Quick detection smoke test |
| `packages/server/test-zenpanda-cdp.js` | Full CDP smoke test |

## What was removed

- `packages/server/lib/browsers/chrome.ts` / `firefox.ts` / `webkit.ts` / `electron.ts`
- `packages/extension/` — Chrome WebExtension
- `packages/runner/` — legacy runner UI
- `npm/puppeteer/` — Puppeteer plugin
- `npm/angular/`, `npm/react/`, `npm/vue/`, `npm/svelte/` — component testing adapters
- `npm/vite-dev-server/`, `npm/webpack-dev-server/`, `npm/webpack-preprocessor/` — bundler integrations
- `tooling/` — V8 snapshot / packherd Electron tooling
- All `system-tests/projects/angular-*`, `react*`, `vue3*`, `svelte-*`, `next-*`, `vite*`, `webpack-*`
- Heavy deps: `@ffmpeg-installer/ffmpeg`, `geckodriver`, `playwright-webkit`, `firefox-profile`, `edgedriver`, `webdriver`

## License

[MIT](/LICENSE)
