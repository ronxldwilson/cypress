# ZenPanda CDP Compatibility Matrix

ZenPanda-supported domains (from upstream docs):
`Accessibility, Audits, Browser, Console, CSS, DOM, Emulation, Fetch, Input, Inspector, Log, Network, Page, Performance, Runtime, Security, Storage, Target, WebMCP`

Cypress makes **47 unique CDP calls** across **10 domains**. Analysis below.

Legend: ✅ Supported · ⚠️ Uncertain (domain exists, method may be partial) · ❌ Not supported · 🗑️ Removed (dead code deleted in ZenPanda fork)

---

## Fetch (3 calls)

| Method | Status | Notes |
|---|---|---|
| Fetch.enable | ✅ | Core interception setup |
| Fetch.continueRequest | ✅ | Used by `cy.intercept()` |
| Fetch.requestPaused (event) | ✅ | Required for intercept to work |

---

## HeapProfiler (1 call)

| Method | Status | Notes |
|---|---|---|
| HeapProfiler.collectGarbage | 🗑️ | Was in memory management — deleted in this fork |

---

## Input (1 call)

| Method | Status | Notes |
|---|---|---|
| Input.dispatchKeyEvent | ✅ | ZenPanda has Input domain |

---

## Inspector (1 call)

| Method | Status | Notes |
|---|---|---|
| Inspector.targetReloadedAfterCrash (event) | ✅ | ZenPanda has Inspector domain |

---

## Network (12 calls)

| Method | Status | Notes |
|---|---|---|
| Network.enable | ✅ | Standard |
| Network.getCookies | ✅ | Standard |
| Network.getAllCookies | ✅ | Standard |
| Network.setCookie | ✅ | Standard |
| Network.setCookies | ⚠️ | Plural form — Chromium extension, may need fallback to repeated setCookie |
| Network.deleteCookies | ✅ | Standard |
| Network.clearBrowserCache | ✅ | Standard |
| Network.clearBrowserCookies | ⚠️ | Older method, may be absent — fallback: deleteCookies loop |
| Network.requestWillBeSent (event) | ✅ | Standard |
| Network.responseReceived (event) | ✅ | Standard |
| Network.requestServedFromCache (event) | ⚠️ | May not fire in ZenPanda |
| Network.loadingFailed (event) | ✅ | Standard |

---

## Page (11 calls)

| Method | Status | Notes |
|---|---|---|
| Page.enable | ✅ | Required for all Page events |
| Page.navigate | ✅ | Core navigation |
| Page.getFrameTree | ✅ | Used for frame tracking |
| Page.addScriptToEvaluateOnNewDocument | ✅ | Used to inject Cypress runner script |
| Page.captureScreenshot | ⚠️ | Needed for `cy.screenshot()` — may be partial |
| Page.bringToFront | ⚠️ | No-op in headless — likely safe to ignore |
| Page.startScreencast | ❌ | Video capture removed in this fork — not needed |
| Page.screencastFrame (event) | ❌ | Same — removed |
| Page.screencastFrameAck | ❌ | Same — removed |
| Page.frameAttached (event) | ✅ | Standard frame lifecycle |
| Page.frameDetached (event) | ✅ | Standard frame lifecycle |

---

## Runtime (8 calls)

| Method | Status | Notes |
|---|---|---|
| Runtime.enable | ✅ | Core |
| Runtime.evaluate | ✅ | Used for every Cypress command |
| Runtime.addBinding | ✅ | Used for Cypress ↔ browser messaging |
| Runtime.runIfWaitingForDebugger | ✅ | Standard |
| Runtime.bindingCalled (event) | ✅ | Required for addBinding |
| Runtime.executionContextCreated (event) | ✅ | Script injection timing |
| Runtime.executionContextDestroyed (event) | ✅ | Cleanup |

---

## ServiceWorker (2 calls)

| Method | Status | Notes |
|---|---|---|
| ServiceWorker.workerRegistrationUpdated (event) | ❌ | ZenPanda does not list ServiceWorker domain |
| ServiceWorker.workerVersionUpdated (event) | ❌ | Same |

> **Impact**: Cypress listens to these for informational purposes in `browser-cri-client.ts`. These are non-blocking — if ZenPanda doesn't support the domain, the `on()` calls will simply never fire. Tests using actual service workers may behave differently.

---

## Storage (1 call)

| Method | Status | Notes |
|---|---|---|
| Storage.clearDataForOrigin | ✅ | ZenPanda has Storage domain |

---

## Target (8 calls)

| Method | Status | Notes |
|---|---|---|
| Target.setDiscoverTargets | ✅ | Required for tab management |
| Target.setAutoAttach | ✅ | Required for new tab detection |
| Target.getTargets | ✅ | Standard |
| Target.createTarget | ✅ | Used when opening new tabs |
| Target.closeTarget | ✅ | Tab cleanup |
| Target.attachedToTarget (event) | ✅ | New tab tracking |
| Target.targetCrashed (event) | ✅ | Error handling |
| Target.targetDestroyed (event) | ✅ | Tab cleanup |

---

## Summary

| Status | Count | Domains |
|---|---|---|
| ✅ Supported | 37 | All critical test automation paths |
| ⚠️ Uncertain | 5 | Network.setCookies, clearBrowserCookies, requestServedFromCache, Page.captureScreenshot, bringToFront |
| ❌ Not supported | 5 | Page.startScreencast/screencastFrame/screencastFrameAck (removed), ServiceWorker events |
| 🗑️ Removed | 1 | HeapProfiler.collectGarbage |

### Risk Assessment

- **Blocking**: None — all core test execution paths (navigate, evaluate, intercept, click) are covered.
- **Degraded**: `cy.screenshot()` may fail if `Page.captureScreenshot` is incomplete. Cookie bulk-set may need fallback.
- **Non-issue**: Screencast/video removed by design. ServiceWorker events are informational only.

### Recommended next steps

1. Test `cy.screenshot()` — if `Page.captureScreenshot` fails, add a no-op guard in `cdp_automation.ts`
2. Test `Network.setCookies` — if missing, patch to loop `Network.setCookie` calls
3. Verify `Network.clearBrowserCookies` — if absent, use `Network.getAllCookies` + `Network.deleteCookies` loop
