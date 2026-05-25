// ZenPanda is a persistent server — Cypress connects to it via CDP WebSocket.
// There is no binary to spawn. This function throws if called.
export function launch () {
  throw new Error(
    'ZenPanda-only mode: browsers are not launched by Cypress. ' +
    'Start ZenPanda separately: zenpanda serve --port 9222\n' +
    'Override host/port with ZENPANDA_HOST / ZENPANDA_PORT env vars.',
  )
}
