import { it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createServer, request as httpRequest, type ServerResponse } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { connect as netConnect, type AddressInfo } from 'node:net'
import { AiSettingsStore, AiService } from '../src/main/ai-service'
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value).reverse(),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
}
it('saves encrypted credentials, keeps them out of renderer settings and clears them explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-ai-'))
  try {
    const store = new AiSettingsStore(directory, cipher)
    await store.save({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local',
      apiKey: 'test-ai-secret',
    })
    expect(await readFile(join(directory, 'ai-settings.json'), 'utf8')).not.toContain(
      'test-ai-secret',
    )
    expect(await store.settings()).toMatchObject({ hasApiKey: true, model: 'local' })
    expect(JSON.stringify(await store.settings())).not.toContain('test-ai-secret')
    const reopened = new AiSettingsStore(directory, cipher)
    expect((await reopened.configuration()).apiKey).toBe('test-ai-secret')
    await reopened.save({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'custom',
    })
    expect((await reopened.configuration()).apiKey).toBe('')
    await reopened.save({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'custom',
      apiKey: '',
    })
    expect((await reopened.settings()).hasApiKey).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('sends the correct provider payloads, extracts reviewable SQL, handles errors and aborts requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-ai-http-'))
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] =
    []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ url: req.url!, body, headers: req.headers })
    if (body.model === 'slow') return
    if (body.model === 'error') {
      res.writeHead(401)
      res.end('test-ai-secret')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      req.url?.endsWith('/messages')
        ? JSON.stringify({
            content: [{ type: 'text', text: '```sql\nSELECT 2;\n```' }],
            stop_reason: 'end_turn',
          })
        : JSON.stringify({
            choices: [{ message: { content: '```sql\nSELECT 1;\n```' }, finish_reason: 'stop' }],
          }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1'
  try {
    const store = new AiSettingsStore(directory, cipher),
      service = new AiService(store)
    await store.save({
      provider: 'openai-compatible',
      baseUrl,
      model: 'local',
      apiKey: 'test-ai-secret',
    })
    const request = {
      id: 'request-1',
      action: 'generate' as const,
      prompt: '生成查询',
      sql: '',
      context: 'users(id,name)',
    }
    expect((await service.complete(1, 'sqlite', request)).sql).toBe('SELECT 1;')
    expect(calls[0]?.url).toBe('/v1/chat/completions')
    expect(calls[0]?.body.stream).toBe(true)
    expect(calls[0]?.headers.authorization).toBe('Bearer test-ai-secret')
    expect(calls[0]?.headers['accept-encoding']).toBe('identity')
    expect(JSON.stringify(calls[0]?.body)).toContain('users(id,name)')
    await store.save({ provider: 'anthropic', baseUrl, model: 'claude', apiKey: 'test-ai-secret' })
    expect(
      (await service.complete(1, 'postgresql', { ...request, action: 'explain', sql: 'SELECT 2;' }))
        .sql,
    ).toBe('SELECT 2;')
    expect(calls[1]?.headers['x-api-key']).toBe('test-ai-secret')
    expect(calls[1]?.body.system).toBeTypeOf('string')
    expect(calls[1]?.body.stream).toBe(true)
    await store.save({ provider: 'openai', baseUrl, model: 'official' })
    await service.complete(1, 'mysql', {
      ...request,
      action: 'optimize',
      sql: 'SELECT 1;',
      history: [{ role: 'user', content: '继续优化' }],
    })
    expect(calls.at(-1)?.body.max_completion_tokens).toBe(4096)
    expect(calls.at(-1)?.body.max_tokens).toBeUndefined()
    expect(calls.at(-1)?.body.stream).toBe(true)
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'error' })
    await expect(service.complete(1, 'sqlite', request)).rejects.toThrow('401')
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'slow' })
    const pending = service.complete(1, 'sqlite', request)
    await new Promise((resolve) => setTimeout(resolve, 50))
    service.cancel(2, request.id)
    expect(service.cancel(1, request.id)).toBe(true)
    await expect(pending).rejects.toThrow('取消')
    await expect(new AiService(store, 20).complete(1, 'sqlite', request)).rejects.toThrow('超时')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
it('refuses plaintext credential fallback and invalid endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-ai-unavailable-'))
  try {
    const store = new AiSettingsStore(directory, { ...cipher, isEncryptionAvailable: () => false })
    await expect(
      store.save({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'custom',
        apiKey: 'never-store-me',
      }),
    ).rejects.toThrow('加密')
    await expect(readFile(join(directory, 'ai-settings.json'), 'utf8')).rejects.toThrow()
    expect(() =>
      store.save({ provider: 'openai', baseUrl: 'file:///tmp/data', model: 'custom' }),
    ).toThrow('地址')
    expect(() =>
      store.save({
        provider: 'openai',
        baseUrl: 'https://secret:pass@example.com/v1',
        model: 'custom',
      }),
    ).toThrow('地址')
    await store.save({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local',
    })
    expect((await store.settings()).hasApiKey).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
function sse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}
async function listen(server: {
  listen(port: number, hostname: string, listeningListener: () => void): unknown
  address(): unknown
}) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo | string | null
  if (!address || typeof address === 'string') throw new Error('测试服务没有端口')
  return address.port
}
it('assembles streamed provider output, redacts secrets split across chunks, and keeps JSON fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-ai-stream-'))
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    if (body.model === 'openai-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, { choices: [{ delta: { content: '泄露 prefix test-ai-' } }] })
      setTimeout(() => {
        sse(res, {
          choices: [
            {
              delta: { content: 'secret 结束\n```sql\nSELECT 8;\n```' },
              finish_reason: 'length',
            },
          ],
        })
        res.write('data: [DONE]\n\n')
        res.end()
      }, 40)
      return
    }
    if (body.model === 'anthropic-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
      )
      res.write(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"```sql\\nSELECT 3;\\n```"}}\n\n',
      )
      res.write(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      )
      res.end()
      return
    }
    if (body.model === 'split') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: '```sql\nSELECT 4;\n```' } }] })}\n\n`
      res.write(payload.slice(0, 9))
      setTimeout(() => {
        res.write(payload.slice(9))
        sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] })
        res.write('data: [DONE]\n\n')
        res.end()
      }, 20)
      return
    }
    if (body.model === 'huge') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = 'x'.repeat(256 * 1024)
      for (let index = 0; index < 5; index += 1)
        sse(res, { choices: [{ delta: { content: chunk } }] })
      res.end()
      return
    }
    if (body.model === 'pause') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse(res, { choices: [{ delta: { content: '部分回答' } }] })
      return
    }
    if (body.model === 'bad-sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {not-json}\n\n')
      return
    }
    if (body.model === 'mislabeled') {
      res.writeHead(200, { 'content-type': 'application/json' })
      sse(res, {
        choices: [{ delta: { content: '```sql\nSELECT 7;\n```' }, finish_reason: 'stop' }],
      })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '```sql\nSELECT 5;\n```' }, finish_reason: 'stop' }],
      }),
    )
  })
  const port = await listen(server)
  const baseUrl = `http://127.0.0.1:${port}/v1`
  try {
    const store = new AiSettingsStore(directory, cipher),
      service = new AiService(store)
    const progress: string[] = []
    await store.save({
      provider: 'openai-compatible',
      baseUrl,
      model: 'openai-stream',
      apiKey: 'test-ai-secret',
    })
    const streamed = await service.complete(
      1,
      'sqlite',
      { id: 'stream-1', action: 'generate', prompt: '查询', sql: '' },
      (update) => progress.push(update.text),
    )
    expect(streamed.sql).toBe('SELECT 8;')
    expect(streamed.truncated).toBe(true)
    expect(streamed.text).toContain('[密钥已隐藏]')
    expect(streamed.text).not.toContain('test-ai-secret')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((text) => !text.includes('test-ai-secret'))).toBe(true)
    await store.save({
      provider: 'anthropic',
      baseUrl,
      model: 'anthropic-stream',
      apiKey: 'test-ai-secret',
    })
    expect(
      (
        await service.complete(1, 'postgresql', {
          id: 'stream-2',
          action: 'explain',
          prompt: '',
          sql: 'SELECT 3;',
        })
      ).sql,
    ).toBe('SELECT 3;')
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'split' })
    expect(
      (
        await service.complete(1, 'mysql', {
          id: 'stream-3',
          action: 'optimize',
          prompt: '优化',
          sql: 'SELECT 4;',
        })
      ).sql,
    ).toBe('SELECT 4;')
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'mislabeled' })
    expect(
      (
        await service.complete(1, 'sqlite', {
          id: 'stream-4b',
          action: 'generate',
          prompt: '标记',
          sql: '',
        })
      ).sql,
    ).toBe('SELECT 7;')
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'json-fallback' })
    expect(
      (
        await service.complete(1, 'sqlite', {
          id: 'stream-4',
          action: 'generate',
          prompt: '继续',
          sql: '',
        })
      ).sql,
    ).toBe('SELECT 5;')
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'huge' })
    await expect(
      service.complete(1, 'sqlite', {
        id: 'stream-5',
        action: 'generate',
        prompt: '太大',
        sql: '',
      }),
    ).rejects.toThrow('1 MiB')
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'bad-sse' })
    await expect(
      service.complete(1, 'sqlite', { id: 'stream-6', action: 'generate', prompt: '坏', sql: '' }),
    ).rejects.toThrow('流式响应')
    await store.save({ provider: 'openai-compatible', baseUrl, model: 'pause' })
    const pendingProgress: string[] = []
    const pending = service.complete(
      1,
      'sqlite',
      { id: 'stream-7', action: 'generate', prompt: '慢', sql: '' },
      (update) => pendingProgress.push(update.text),
    )
    for (
      let attempt = 0;
      attempt < 50 && !pendingProgress.some((text) => text.includes('部分回答'));
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.cancel(1, 'stream-7')).toBe(true)
    await expect(pending).rejects.toThrow('取消')
    expect(pendingProgress.some((text) => text.includes('部分回答'))).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
it('sends AI requests through an HTTP proxy and stores proxy passwords encrypted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-ai-proxy-'))
  const seen: {
    auth?: string
    upstream: Record<string, unknown>
    body: Record<string, unknown>
  }[] = []
  const upstream = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    seen.push({ upstream: req.headers, body: JSON.parse(text) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(res, { choices: [{ delta: { content: '```sql\nSELECT 6;\n```' } }] })
    setTimeout(() => {
      sse(res, { choices: [{ delta: { content: ' 完成' }, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      res.end()
    }, 30)
  })
  const upstreamPort = await listen(upstream)
  const proxy = createServer((req, res) => {
    if (
      req.headers['proxy-authorization'] !==
      'Basic ' + Buffer.from('proxy-user:proxy-secret').toString('base64')
    ) {
      res.writeHead(407)
      res.end()
      return
    }
    const target = new URL(req.url || '')
    const headers = { ...req.headers, host: target.host, 'x-test-proxy': '1' }
    delete headers['proxy-authorization']
    const forwarded = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers)
        up.pipe(res)
      },
    )
    forwarded.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(forwarded)
  })
  const proxyPort = await listen(proxy)
  try {
    const store = new AiSettingsStore(directory, cipher)
    const service = new AiService(store)
    const base = {
      provider: 'openai-compatible' as const,
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: 'proxied',
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      proxyUsername: 'proxy-user',
    }
    await store.save({ ...base, apiKey: 'test-ai-secret' })
    await expect(
      service.complete(1, 'sqlite', { id: 'proxy-1', action: 'generate', prompt: '查询', sql: '' }),
    ).rejects.toThrow('认证')
    expect(seen).toHaveLength(0)
    await store.save({ ...base, apiKey: 'test-ai-secret', proxyPassword: 'proxy-secret' })
    const file = await readFile(join(directory, 'ai-settings.json'), 'utf8')
    expect(file).not.toContain('proxy-secret')
    expect(file).not.toContain('test-ai-secret')
    const settings = await store.settings()
    expect(settings).toMatchObject({
      proxyUrl: base.proxyUrl,
      proxyUsername: 'proxy-user',
      hasProxyPassword: true,
    })
    expect(JSON.stringify(settings)).not.toContain('proxy-secret')
    const progress: string[] = []
    const result = await service.complete(
      1,
      'sqlite',
      { id: 'proxy-2', action: 'generate', prompt: '查询', sql: '' },
      (update) => progress.push(update.text),
    )
    expect(result.sql).toBe('SELECT 6;')
    expect(progress.some((text) => text.includes('SELECT 6') && !text.includes('完成'))).toBe(true)
    expect(
      progress.every((text) => !text.includes('proxy-secret') && !text.includes('test-ai-secret')),
    ).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.body.stream).toBe(true)
    expect(seen[0]?.upstream['x-test-proxy']).toBe('1')
    expect(seen[0]?.upstream.authorization).toBe('Bearer test-ai-secret')
    expect(JSON.stringify(seen[0]?.upstream)).not.toContain('proxy-secret')
    await store.save({ ...base, model: 'kept' })
    expect((await store.configuration()).proxyPassword).toBe('proxy-secret')
    await store.save({ ...base, provider: 'openai', model: 'official' })
    expect((await store.configuration()).proxyPassword).toBe('proxy-secret')
    await store.save({ ...base, proxyUrl: 'http://127.0.0.1:9', model: 'moved' })
    expect((await store.configuration()).proxyPassword).toBe('')
    await store.save({ ...base, proxyPassword: 'proxy-secret' })
    await store.save({ ...base, proxyPassword: '' })
    expect((await store.settings()).hasProxyPassword).toBe(false)
    expect(() => store.save({ ...base, proxyUrl: 'http://user:pass@127.0.0.1:1' })).toThrow('凭据')
    expect(() => store.save({ ...base, proxyUrl: 'http://127.0.0.1:1/hop' })).toThrow('路径')
    expect(() =>
      store.save({ ...base, proxyUrl: 'http://127.0.0.1:1', proxyUsername: 'a:b' }),
    ).toThrow('用户名')
    expect(() => store.save({ ...base, proxyPassword: 'line\nbreak' })).toThrow('代理密码')
    await store.save({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'https-proxy',
      proxyUrl: 'https://proxy.example:8443',
    })
    expect((await store.settings()).proxyUrl).toBe('https://proxy.example:8443')
  } finally {
    upstream.closeAllConnections()
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
it('rejects untrusted proxy and service certificates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-ai-tls-'))
  const certDir = mkdtempSync(join(tmpdir(), 'vork-ai-cert-'))
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    join(certDir, 'key.pem'),
    '-out',
    join(certDir, 'cert.pem'),
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ])
  const tlsOptions = {
    key: readFileSync(join(certDir, 'key.pem')),
    cert: readFileSync(join(certDir, 'cert.pem')),
  }
  let serviceHits = 0
  let connects = 0
  const service = createHttps(tlsOptions, (_req, res) => {
    serviceHits += 1
    res.end('no')
  })
  const proxyTls = createHttps(tlsOptions, (_req, res) => {
    serviceHits += 1
    res.end('no')
  })
  const tunnel = createServer()
  tunnel.on('connect', (req, clientSocket, head) => {
    connects += 1
    const [, port] = String(req.url).split(':')
    const remote = netConnect(Number(port), '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) remote.write(head)
      remote.pipe(clientSocket)
      clientSocket.pipe(remote)
    })
    remote.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => remote.destroy())
  })
  const servicePort = await listen(service)
  const proxyPort = await listen(proxyTls)
  const tunnelPort = await listen(tunnel)
  try {
    const store = new AiSettingsStore(directory, cipher)
    const ai = new AiService(store)
    await store.save({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'tls',
      proxyUrl: `https://127.0.0.1:${proxyPort}`,
    })
    await expect(
      ai.complete(1, 'sqlite', { id: 'tls-1', action: 'generate', prompt: '查询', sql: '' }),
    ).rejects.toThrow('代理的 TLS 证书不受信任')
    await store.save({
      provider: 'openai-compatible',
      baseUrl: `https://127.0.0.1:${servicePort}/v1`,
      model: 'tls',
      proxyUrl: `http://127.0.0.1:${tunnelPort}`,
    })
    await expect(
      ai.complete(1, 'sqlite', { id: 'tls-2', action: 'generate', prompt: '查询', sql: '' }),
    ).rejects.toThrow('服务的 TLS 证书不受信任')
    expect(connects).toBe(1)
    expect(serviceHits).toBe(0)
  } finally {
    service.closeAllConnections()
    proxyTls.closeAllConnections()
    tunnel.closeAllConnections()
    await new Promise<void>((resolve) => service.close(() => resolve()))
    await new Promise<void>((resolve) => proxyTls.close(() => resolve()))
    await new Promise<void>((resolve) => tunnel.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    await rm(certDir, { recursive: true, force: true })
  }
})
it('refuses to save a proxy password when system encryption is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-ai-proxy-lock-'))
  try {
    const store = new AiSettingsStore(directory, { ...cipher, isEncryptionAvailable: () => false })
    await expect(
      store.save({
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'local',
        proxyUrl: 'http://127.0.0.1:9',
        proxyPassword: 'never-store-me',
      }),
    ).rejects.toThrow('加密')
    await store.save({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'local',
      proxyUrl: 'http://127.0.0.1:9',
    })
    expect((await store.settings()).hasProxyPassword).toBe(false)
    expect(await readFile(join(directory, 'ai-settings.json'), 'utf8')).not.toContain(
      'never-store-me',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
