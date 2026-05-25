/**
 * CDP smoke test via raw WebSocket — no npm deps needed.
 * node test-zenpanda-cdp.js
 */

const http = require('http')

const host = process.env.ZENPANDA_HOST || '127.0.0.1'
const port = Number(process.env.ZENPANDA_PORT || 9222)

async function getWsUrl () {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path: '/json/version' }, (res) => {
      let body = ''
      res.on('data', (c) => body += c)
      res.on('end', () => {
        try {
          const info = JSON.parse(body)
          resolve(info.webSocketDebuggerUrl.replace('0.0.0.0', '127.0.0.1'))
        } catch (e) {
          reject(new Error(`Bad /json/version response: ${body}`))
        }
      })
    }).on('error', reject)
  })
}

let msgId = 1

function cdpSend (ws, method, params = {}, sessionId = null) {
  const id = msgId++
  const msg = { id, method, params }
  if (sessionId) msg.sessionId = sessionId
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const m = JSON.parse(event.data)
      if (m.id === id) {
        ws.removeEventListener('message', handler)
        if (m.error) reject(new Error(`${method} error: ${m.error.message}`))
        else resolve(m.result)
      }
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify(msg))
  })
}

async function run () {
  console.log(`Connecting to ZenPanda CDP at ${host}:${port} ...\n`)

  const wsUrl = await getWsUrl().catch((e) => {
    console.error('❌ ZenPanda not reachable:', e.message)
    process.exit(1)
  })
  console.log(`  WS endpoint: ${wsUrl}`)

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', (e) => rej(new Error(e.message || 'WebSocket error')))
  })
  console.log('✅ Browser-level WebSocket connected\n')

  try {
    // 1. Create a new page target
    const target = await cdpSend(ws, 'Target.createTarget', { url: 'about:blank' })
    console.log(`✅ Target.createTarget → targetId=${target.targetId}`)

    // 2. Attach to the target to get a session
    const attached = await cdpSend(ws, 'Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    const sessionId = attached.sessionId
    console.log(`✅ Target.attachToTarget → sessionId=${sessionId}\n`)

    // From here, all domain commands use sessionId to route to the page
    const send = (method, params) => cdpSend(ws, method, params, sessionId)

    // 3. Enable Page and Network domains on the session
    await send('Page.enable')
    console.log('✅ Page.enable')
    await send('Network.enable')
    console.log('✅ Network.enable')

    // 4. Navigate
    const nav = await send('Page.navigate', { url: 'https://example.com' })
    console.log(`✅ Page.navigate → frameId=${nav.frameId}`)

    // wait for load
    await new Promise((r) => setTimeout(r, 2000))

    // 5. Evaluate JS
    const evalRes = await send('Runtime.evaluate', { expression: 'document.title' })
    console.log(`✅ document.title = "${evalRes.result.value}"`)

    // 6. DOM
    const domRes = await send('DOM.getDocument', { depth: 1 })
    console.log(`✅ DOM root: <${domRes.root.localName}> nodeId=${domRes.root.nodeId}`)

    const qRes = await send('DOM.querySelector', { nodeId: domRes.root.nodeId, selector: 'h1' })
    if (qRes.nodeId) {
      const html = await send('DOM.getOuterHTML', { nodeId: qRes.nodeId })
      console.log(`✅ h1: ${html.outerHTML.slice(0, 80)}`)
    } else {
      console.log('⚠️  No h1 found')
    }

    console.log('\n🎉 All CDP smoke tests passed — ZenPanda integration is working!')
  } catch (e) {
    console.error('\n❌ CDP test failed:', e.message)
    // Print available CDP commands if target creation failed
    if (e.message.includes('createTarget')) {
      console.log('\nTrying to list /json endpoints for debugging...')
      await new Promise((res) => {
        http.get({ host, port, path: '/json/list' }, (r) => {
          let b = ''
          r.on('data', (c) => b += c)
          r.on('end', () => { console.log('/json/list:', b); res() })
        }).on('error', res)
      })
    }
  } finally {
    ws.close(1000)
  }
}

run()
