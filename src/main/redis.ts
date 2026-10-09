import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { createClient, RESP_TYPES } from 'redis'
import type { ConnectionConfig } from '../shared/contracts'
import type { Adapter } from './adapters'
import { RedisBrowser } from './redis-browser'

export async function openRedis(
  config: ConnectionConfig,
  onError: (message: string) => void,
  endpoint?: { host: string; port: number },
): Promise<Adapter> {
  const database = Number(config.database || 0)
  const client = createClient({
    RESP: 2, // Typed raw commands below use RESP2 array layouts, including ZRANGE WITHSCORES.
    socket: {
      host: endpoint?.host || config.host,
      port: endpoint?.port || config.port,
      connectTimeout: 10000,
      reconnectStrategy: false,
      ...(config.tls
        ? {
            tls: true,
            rejectUnauthorized: true,
            ...(endpoint
              ? {
                  servername: isIP(config.host!) ? undefined : config.host,
                  checkServerIdentity: (
                    _host: string,
                    cert: Parameters<typeof checkServerIdentity>[1],
                  ) => checkServerIdentity(config.host!, cert),
                }
              : {}),
          }
        : {}),
    },
    username: config.username || undefined,
    password: config.password || undefined,
    database,
  })
  let connected = false
  client.on('error', (e) => {
    if (connected) onError(e.message)
  })
  client.on('end', () => {
    if (connected) onError('Redis 连接已断开')
  })
  try {
    await client.connect()
    connected = true
  } catch (error) {
    if (client.isOpen) client.destroy()
    throw error
  }
  const browser = new RedisBrowser((args, binary) =>
    client.sendCommand(
      args,
      binary ? { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } } : undefined,
    ),
  )
  return {
    async execute(command) {
      const reply = await browser.request({ kind: 'command', database, command })
      if (reply.kind !== 'command') throw new Error('Redis 命令响应无效')
      return reply.result
    },
    redisRequest: (request) => browser.request(request),
    async close() {
      connected = false
      if (client.isOpen) client.destroy()
    },
  }
}
