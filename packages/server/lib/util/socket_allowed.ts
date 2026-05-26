import _ from 'lodash'
import Debug from 'debug'
import type net from 'net'
import type { Request } from 'express'

const debug = Debug('cypress:server:util:socket_allowed')

const DOCKER_BRIDGE_RE = /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/

/**
 * Utility to validate incoming, local socket connections against a list of
 * expected client TCP ports.
 */
export class SocketAllowed {
  allowedLocalPorts: number[] = []

  /**
   * Add a socket to the allowed list.
   */
  add = (socket: net.Socket) => {
    const { localPort } = socket

    debug('allowing socket %o', { localPort })
    this.allowedLocalPorts.push(localPort as number)

    socket.once('close', () => {
      debug('allowed socket closed, removing %o', { localPort })
      this._remove(socket)
    })
  }

  _remove (socket: net.Socket) {
    _.pull(this.allowedLocalPorts, socket.localPort)
  }

  /**
   * Is this socket that this request originated allowed?
   */
  isRequestAllowed (req: Request) {
    const { remotePort, remoteAddress } = req.socket
    const remotePortInAllowList = this.allowedLocalPorts.includes(remotePort!)

    // When testing cypress in cypress, we pass along the x-cypress-forwarded-from-cypress header to signify this is a safe request
    const trustedSourceUsingCypressInCypress = !!process.env.CYPRESS_INTERNAL_E2E_TESTING_SELF && !!req.headers['x-cypress-forwarded-from-cypress']
    const isLocalhost = ['127.0.0.1', '::1'].includes(remoteAddress!)
    const isDockerBridge = process.env.ZENPANDA_RUNNER_HOST === 'host.docker.internal' && DOCKER_BRIDGE_RE.test(remoteAddress!)
    const isAllowed = (remotePortInAllowList || trustedSourceUsingCypressInCypress || isDockerBridge) && (isLocalhost || isDockerBridge)

    debug('is incoming request allowed? %o', { isAllowed, reqUrl: req.url, remotePort, remoteAddress })

    return isAllowed
  }
}
