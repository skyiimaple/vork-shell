import { it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
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
    expect(calls[0]?.headers.authorization).toBe('Bearer test-ai-secret')
    expect(JSON.stringify(calls[0]?.body)).toContain('users(id,name)')
    await store.save({ provider: 'anthropic', baseUrl, model: 'claude', apiKey: 'test-ai-secret' })
    expect(
      (await service.complete(1, 'postgresql', { ...request, action: 'explain', sql: 'SELECT 2;' }))
        .sql,
    ).toBe('SELECT 2;')
    expect(calls[1]?.headers['x-api-key']).toBe('test-ai-secret')
    expect(calls[1]?.body.system).toBeTypeOf('string')
    await store.save({ provider: 'openai', baseUrl, model: 'official' })
    await service.complete(1, 'mysql', {
      ...request,
      action: 'optimize',
      sql: 'SELECT 1;',
      history: [{ role: 'user', content: '继续优化' }],
    })
    expect(calls.at(-1)?.body.max_completion_tokens).toBe(4096)
    expect(calls.at(-1)?.body.max_tokens).toBeUndefined()
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
