import { Agent, request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'

export interface AiProxy {
  url: string
  username: string
  password: string
}
export interface AiHttpResponse {
  status: number
  header(name: string): string | null
  body: ReadableStream<Uint8Array> | null
  close(): void
}

const tlsCodes = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

function aborted(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
  )
}
function transportFailure(error: unknown, target: 'proxy' | 'service') {
  if (aborted(error)) return error instanceof Error ? error : new Error('AI 请求已取消')
  const cause = error instanceof Error ? error : new Error('failed')
  const code = (cause as NodeJS.ErrnoException).code || ''
  if (tlsCodes.has(code) || /certificate|altname/i.test(cause.message))
    return new Error(
      target === 'proxy' ? 'AI 代理的 TLS 证书不受信任' : 'AI 服务的 TLS 证书不受信任',
    )
  return new Error(
    target === 'proxy'
      ? '无法通过代理连接 AI 服务，请检查代理地址'
      : '无法连接 AI 服务，请检查网络和服务地址',
  )
}
function authority(url: URL) {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname
  return `${host}:${port}`
}
function endpoint(url: URL) {
  const secure = url.protocol === 'https:'
  return {
    hostname: url.hostname,
    port: Number(url.port || (secure ? 443 : 80)),
    ...(secure && !isIP(url.hostname) ? { servername: url.hostname } : {}),
  }
}
function headerValue(message: IncomingMessage, name: string) {
  const value = message.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value.join(', ')
  return value ?? null
}
function webResponse(message: IncomingMessage): AiHttpResponse {
  return {
    status: message.statusCode || 0,
    header: (name) => headerValue(message, name),
    body: Readable.toWeb(message) as ReadableStream<Uint8Array>,
    close: () => message.destroy(),
  }
}
class TunnelAgent extends Agent {
  constructor(private tunnel: Socket) {
    super({ keepAlive: false, maxSockets: 1 })
  }
  override createConnection(
    _options: Parameters<Agent['createConnection']>[0],
    callback?: (err: Error | null, stream: Socket) => void,
  ) {
    callback?.(null, this.tunnel)
    return this.tunnel
  }
}
function basicAuth(username: string, password: string) {
  if (!username && !password) return undefined
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
}
function connectTunnel(proxy: URL, target: URL, auth: string | undefined, signal: AbortSignal) {
  const secure = proxy.protocol === 'https:'
  const request = secure ? httpsRequest : httpRequest
  const targetAuthority = authority(target)
  return new Promise<Socket>((resolve, reject) => {
    const req = request({
      ...endpoint(proxy),
      method: 'CONNECT',
      path: targetAuthority,
      headers: { host: targetAuthority, ...(auth ? { 'proxy-authorization': auth } : {}) },
      signal,
    })
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        const status = res.statusCode || 0
        socket.destroy()
        reject(
          status === 407
            ? new Error('AI 代理需要认证或凭据不正确')
            : new Error(`AI 代理拒绝连接（HTTP ${status}）`),
        )
        return
      }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.once('error', (error) => reject(transportFailure(error, 'proxy')))
    req.end()
  })
}
function secureSocket(socket: Socket, hostname: string, signal: AbortSignal) {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false
    const tls = tlsConnect({
      socket,
      host: hostname,
      ...(isIP(hostname) ? {} : { servername: hostname }),
      rejectUnauthorized: true,
    })
    const finish = (error?: unknown, stream?: Socket) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error) {
        tls.destroy()
        reject(error)
        return
      }
      resolve(stream!)
    }
    const onAbort = () => finish(signal.reason ?? new Error('AI 请求已取消'))
    if (signal.aborted) {
      finish(signal.reason ?? new Error('AI 请求已取消'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    tls.once('secureConnect', () => {
      if (tls.authorized) finish(undefined, tls)
      else
        finish(
          transportFailure(
            Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }),
            'service',
          ),
        )
    })
    tls.once('error', (error) => finish(transportFailure(error, 'service')))
  })
}
function requestOnSocket(
  socket: Socket,
  target: URL,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
        method: 'POST',
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          host: target.host,
          'content-length': Buffer.byteLength(body),
          connection: 'close',
        },
        agent: new TunnelAgent(socket),
        signal,
      },
      resolve,
    )
    req.once('error', (error) => {
      socket.destroy()
      reject(transportFailure(error, 'service'))
    })
    req.end(body)
  })
}
function forward(
  proxy: URL,
  target: URL,
  headers: Record<string, string>,
  body: string,
  auth: string | undefined,
  signal: AbortSignal,
) {
  const request = proxy.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        ...endpoint(proxy),
        method: 'POST',
        path: target.href,
        headers: {
          ...headers,
          host: target.host,
          'content-length': Buffer.byteLength(body),
          connection: 'close',
          ...(auth ? { 'proxy-authorization': auth } : {}),
        },
        signal,
      },
      resolve,
    )
    req.once('error', (error) => reject(transportFailure(error, 'proxy')))
    req.end(body)
  })
}

export async function aiFetch(
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
  proxy?: AiProxy,
): Promise<AiHttpResponse> {
  if (!proxy?.url) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        redirect: 'error',
      })
      return {
        status: response.status,
        header: (name) => response.headers.get(name),
        body: response.body,
        close: () => {
          void response.body?.cancel().catch(() => {})
        },
      }
    } catch (error) {
      if (init.signal.aborted || aborted(error))
        throw error instanceof Error ? error : new Error('AI 请求已取消')
      throw transportFailure(error, 'service')
    }
  }
  const target = new URL(url),
    proxyUrl = new URL(proxy.url),
    auth = basicAuth(proxy.username, proxy.password)
  const incoming =
    target.protocol === 'https:'
      ? await requestOnSocket(
          await secureSocket(
            await connectTunnel(proxyUrl, target, auth, init.signal),
            target.hostname,
            init.signal,
          ),
          target,
          init.headers,
          init.body,
          init.signal,
        )
      : await forward(proxyUrl, target, init.headers, init.body, auth, init.signal)
  if (incoming.statusCode === 407) {
    incoming.destroy()
    throw new Error('AI 代理需要认证或凭据不正确')
  }
  return webResponse(incoming)
}
