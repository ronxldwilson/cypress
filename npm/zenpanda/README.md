# @cypress/zenpanda

Run your Cypress tests against [ZenPanda](https://github.com/lightpanda-io/browser) — a multi-tenant headless browser that speaks CDP and uses **16× less memory** than headless Chrome.

ZenPanda is a fork of [Lightpanda](https://github.com/lightpanda-io/browser), written in Zig with V8 for JavaScript execution. Unlike Chrome or Firefox, ZenPanda runs as a **persistent server** — Cypress connects to it over CDP WebSocket rather than spawning it.

---

## Requirements

- Cypress ≥ 13.0.0
- A running ZenPanda server (default: `http://127.0.0.1:9222`)

Start ZenPanda:

```bash
zenpanda serve --port 9222
```

---

## Installation

```bash
npm install --save-dev @cypress/zenpanda
# or
yarn add --dev @cypress/zenpanda
```

---

## Usage

### Option A — `defineZenPandaConfig` (quickest)

Wraps your existing Cypress config and injects ZenPanda automatically:

```ts
// cypress.config.ts
import { defineConfig } from 'cypress'
import { defineZenPandaConfig } from '@cypress/zenpanda'

export default defineConfig(
  defineZenPandaConfig({
    e2e: {
      baseUrl: 'http://localhost:3000',
    },
  })
)
```

Then run:

```bash
npx cypress run --browser zenpanda
```

### Option B — `addZenPandaBrowser` (composable)

Call inside your own `setupNodeEvents` to add ZenPanda alongside other browsers:

```ts
// cypress.config.ts
import { defineConfig } from 'cypress'
import { addZenPandaBrowser } from '@cypress/zenpanda'

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      addZenPandaBrowser(on, config)
      return config
    },
  },
})
```

### Option C — Zero config (auto-detection)

If ZenPanda is listed in Cypress's detected browsers (it probes `127.0.0.1:9222` on startup), you can skip the plugin entirely:

```bash
npx cypress run --browser zenpanda
```

---

## Configuration

| Environment variable | Default       | Description                     |
|----------------------|---------------|---------------------------------|
| `ZENPANDA_HOST`      | `127.0.0.1`   | ZenPanda server hostname        |
| `ZENPANDA_PORT`      | `9222`        | ZenPanda CDP server port        |

### Custom host/port via plugin options

```ts
defineZenPandaConfig(
  { e2e: { baseUrl: 'http://localhost:3000' } },
  { host: '10.0.0.5', port: 9300 }
)
```

---

## How it works

ZenPanda speaks the [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/). Cypress uses the same CDP machinery it uses for Chrome — the only difference is:

1. **Detection**: instead of looking for a binary, Cypress probes `GET /json/version` on the ZenPanda server.
2. **Launch**: instead of spawning a process, Cypress connects via CDP WebSocket to the running ZenPanda instance.
3. **Teardown**: when the test run ends, Cypress disconnects its CDP session. ZenPanda keeps running.

---

## Limitations

- **No video recording** — ZenPanda does not support screen capture yet.
- **No extension loading** — WebExtensions are not supported.
- **No Studio** — Test Studio is CDP-based but relies on Chrome-specific features.
- **Single origin** — ZenPanda may not support cross-origin iframes in all cases; check the ZenPanda compatibility matrix.
- **Experimental** — ZenPanda's CDP implementation is evolving rapidly.

---

## License

MIT
