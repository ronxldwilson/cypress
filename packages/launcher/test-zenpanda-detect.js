/**
 * Quick smoke test: does ZenPanda detection work?
 * Run with: node -r @packages/ts/register test-zenpanda-detect.js
 * Or just: node test-zenpanda-detect.js  (after build)
 *
 * With ZenPanda running: should print a FoundBrowser object.
 * Without ZenPanda running: should print "ZenPanda not detected (not running?)"
 */

const http = require('http')

const host = process.env.ZENPANDA_HOST || '127.0.0.1'
const port = Number(process.env.ZENPANDA_PORT || 9222)

console.log(`Probing ZenPanda at http://${host}:${port}/json/version ...`)

const req = http.get({ host, port, path: '/json/version', timeout: 2000 }, (res) => {
  let body = ''
  res.on('data', (c) => body += c)
  res.on('end', () => {
    try {
      const info = JSON.parse(body)
      const version = (info['Browser'] || info['Version'] || '0.0.0').replace(/[^0-9.]/g, '') || '0.0.0'
      console.log('\n✅ ZenPanda detected!')
      console.log({
        name: 'zenpanda',
        family: 'zenpanda',
        displayName: 'ZenPanda',
        version,
        majorVersion: version.split('.')[0],
        path: `http://${host}:${port}`,
        rawResponse: info,
      })
    } catch (e) {
      console.error('❌ Could not parse /json/version response:', body)
    }
  })
})

req.on('error', (e) => {
  console.log(`\n⚠️  ZenPanda not detected (not running?): ${e.message}`)
  console.log(`   Start ZenPanda with: zenpanda serve --port ${port}`)
})
req.on('timeout', () => { req.destroy(); console.log('❌ Timed out') })
