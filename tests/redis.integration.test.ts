import { createRequire } from 'node:module'
import { SessionManager } from '../src/main/sessions'
import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createClient } from 'redis'
import { openRedis } from '../src/main/redis'

it.runIf(Boolean(process.env.VORK_REDIS_SERVER))(
  'verifies the Redis workspace against a real isolated Redis server',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vork-redis-test-'))
    const socket = createServer()
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
    const address = socket.address()
    if (!address || typeof address === 'string') throw new Error('测试端口无效')
    const port = address.port
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    const processHandle = spawn(
      process.env.VORK_REDIS_SERVER!,
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const stopped = new Promise<void>((resolve) => processHandle.once('exit', () => resolve()))
    let log = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(log || 'Redis 测试服务启动超时')), 10000)
      processHandle.on('error', reject)
      processHandle.stdout.on('data', (data) => {
        log += data.toString()
        if (log.includes('Ready to accept connections')) {
          clearTimeout(timer)
          resolve()
        }
      })
      processHandle.stderr.on('data', (data) => (log += data.toString()))
      processHandle.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Redis exited ${code}: ${log}`))
      })
    })
    const setup = createClient({ socket: { host: '127.0.0.1', port, reconnectStrategy: false } })
    setup.on('error', () => {})
    let adapter: Awaited<ReturnType<typeof openRedis>> | undefined
    try {
      await setup.connect()
      await setup.set('string:empty', '')
      await setup.set('string:ttl', 'original', { EX: 300 })
      await setup.set('string:huge', 'x'.repeat(70000))
      await setup.set('string:binary', Buffer.from([0xff, 0xfe]))
      await setup.hSet('hash:sample', { alpha: 'one', beta: 'two' })
      await setup.rPush('list:sample', ['a', 'b', 'c'])
      await setup.sAdd('set:sample', ['one', 'two'])
      await setup.zAdd('zset:sample', [{ score: 1.5, value: 'member' }])
      await setup.xAdd('stream:sample', '*', { field: 'value' })
      adapter = await openRedis(
        { type: 'redis', name: 'test', host: '127.0.0.1', port, database: '0' },
        (message) => {
          throw new Error(message)
        },
      )
      const request = adapter.redisRequest!
      const scan = await request({
        kind: 'scan',
        database: 0,
        cursor: '0',
        match: '*',
        count: 1000,
      })
      expect(scan.kind).toBe('scan')
      if (scan.kind === 'scan') expect(scan.keys).toContain('string:ttl')
      expect(await request({ kind: 'read', database: 0, key: 'string:empty' })).toMatchObject({
        type: 'string',
        text: '',
        size: 0,
        ttl: -1,
      })
      expect(await request({ kind: 'read', database: 0, key: 'string:huge' })).toMatchObject({
        truncated: true,
        size: 70000,
      })
      expect(await request({ kind: 'read', database: 0, key: 'string:binary' })).toMatchObject({
        encoding: 'hex',
        text: 'fffe',
      })
      expect(
        await request({ kind: 'read', database: 0, key: 'list:sample', count: 2 }),
      ).toMatchObject({
        rows: [
          [0, 'a'],
          [1, 'b'],
        ],
        nextCursor: '2',
      })
      expect(
        await request({ kind: 'read', database: 0, key: 'list:sample', cursor: '2', count: 2 }),
      ).toMatchObject({ rows: [[2, 'c']], nextCursor: null })
      expect(await request({ kind: 'read', database: 0, key: 'hash:sample' })).toMatchObject({
        type: 'hash',
        size: 2,
      })
      expect(await request({ kind: 'read', database: 0, key: 'set:sample' })).toMatchObject({
        type: 'set',
        size: 2,
      })
      expect(await request({ kind: 'read', database: 0, key: 'zset:sample' })).toMatchObject({
        rows: [['member', '1.5']],
      })
      const stream = await request({ kind: 'read', database: 0, key: 'stream:sample', count: 1 })
      expect(stream.kind).toBe('read')
      if (stream.kind === 'read') {
        expect(stream.nextCursor).toMatch(/^\d+-\d+$/)
        expect(
          await request({
            kind: 'read',
            database: 0,
            key: 'stream:sample',
            count: 1,
            cursor: stream.nextCursor!,
          }),
        ).toMatchObject({ rows: [], nextCursor: null })
      }
      await request({
        kind: 'set-string',
        database: 0,
        key: 'string:ttl',
        expected: 'original',
        value: 'updated',
      })
      expect(await setup.get('string:ttl')).toBe('updated')
      expect(await setup.ttl('string:ttl')).toBeGreaterThan(0)
      await expect(
        request({
          kind: 'set-string',
          database: 0,
          key: 'string:ttl',
          expected: 'original',
          value: 'stale',
        }),
      ).rejects.toThrow(/其他客户端/)
      await expect(
        request({ kind: 'rename', database: 0, key: 'string:ttl', newKey: 'string:empty' }),
      ).rejects.toThrow(/存在/)
      expect(await setup.get('string:empty')).toBe('')
      await request({ kind: 'persist', database: 0, key: 'string:ttl' })
      expect(await setup.ttl('string:ttl')).toBe(-1)
      await request({ kind: 'expire', database: 0, key: 'string:ttl', seconds: 100 })
      expect(await setup.ttl('string:ttl')).toBeGreaterThan(0)
      await request({ kind: 'rename', database: 0, key: 'string:ttl', newKey: 'string:renamed' })
      await request({ kind: 'delete', database: 0, key: 'string:renamed' })
      expect(await setup.exists('string:renamed')).toBe(0)
      const bulkRead = await request({
        kind: 'ttl-batch',
        database: 0,
        keys: ['string:empty', 'missing-bulk'],
      })
      expect(bulkRead).toMatchObject({
        kind: 'ttl-batch',
        results: [
          { key: 'string:empty', ok: true, ttl: -1 },
          { key: 'missing-bulk', ok: true, ttl: -2 },
        ],
      })
      expect(
        await request({
          kind: 'expire-batch',
          operation: 'expire',
          database: 0,
          keys: ['string:empty', 'missing-bulk'],
          seconds: 90,
        }),
      ).toMatchObject({ kind: 'bulk-mutation', results: [{ affected: 1 }, { affected: 0 }] })
      expect(await setup.ttl('string:empty')).toBeGreaterThan(0)
      await request({
        kind: 'expire-batch',
        operation: 'persist',
        database: 0,
        keys: ['string:empty'],
      })
      expect(await setup.ttl('string:empty')).toBe(-1)
      expect(
        await request({ kind: 'ttl-batch', database: 1, keys: ['string:empty'] }),
      ).toMatchObject({ results: [{ ttl: -2 }] })
      expect(await request({ kind: 'scan', database: 1, cursor: '0' })).toMatchObject({
        keys: [],
        cursor: '0',
      })
      expect(await request({ kind: 'info', database: 0 })).toMatchObject({ keyCount: 8 })
      for (const type of ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const) {
        await request({
          kind: 'create',
          database: 0,
          key: 'new:' + type,
          type,
          value: '<script>{"ok":true}',
          member: 'field',
          score: '1.5',
          seconds: 60,
        })
        expect(await setup.type('new:' + type)).toBe(type)
        expect(await setup.ttl('new:' + type)).toBeGreaterThan(0)
        await expect(
          request({
            kind: 'create',
            database: 0,
            key: 'new:' + type,
            type,
            value: 'overwrite',
            member: 'field',
            score: '2',
          }),
        ).rejects.toThrow(/存在/)
        expect(await setup.ttl('new:' + type)).toBeGreaterThan(0)
      }
      await setup.sendCommand([
        'ACL',
        'SETUSER',
        'no-expire',
        'on',
        '>test-only',
        '~*',
        '+@all',
        '-expire',
      ])
      const limited = await openRedis(
        {
          type: 'redis',
          name: 'limited',
          host: '127.0.0.1',
          port,
          username: 'no-expire',
          password: 'test-only',
          database: '0',
        },
        () => {},
      )
      try {
        await expect(
          limited.redisRequest!({
            kind: 'create',
            database: 0,
            key: 'acl-create',
            type: 'hash',
            member: 'field',
            value: 'value',
            seconds: 60,
          }),
        ).rejects.toThrow()
        expect(await setup.exists('acl-create')).toBe(0)
      } finally {
        await limited.close()
        await setup.sendCommand(['ACL', 'DELUSER', 'no-expire'])
      }
      await expect(
        request({
          kind: 'create',
          database: 0,
          key: 'invalid-score',
          type: 'zset',
          value: 'x',
          score: 'NaN',
        }),
      ).rejects.toThrow(/分数/)
      expect(await setup.exists('invalid-score')).toBe(0)

      expect(await request({ kind: 'command', database: 0, command: 'PING' })).toMatchObject({
        result: { rows: [['PONG']] },
      })
      const { createSshFixture } = createRequire(import.meta.url)('../scripts/ssh-fixture.cjs')
      const sshFixture = await createSshFixture()
      sshFixture.hooks.allowForward = (target: number) => target === port
      const manager = new SessionManager(
        () => {},
        async () => true,
        async () => ({
          type: 'ssh',
          name: 'fixture',
          host: '127.0.0.1',
          port: sshFixture.port,
          username: 'fixture',
          password: 'fixture',
        }),
      )
      try {
        const tunneled = await manager.connect(91, {
          type: 'redis',
          name: 'tunneled',
          host: '127.0.0.1',
          port,
          sshProfileId: 'saved-ssh',
        })
        expect(tunneled.target).toContain('经 SSH')
        expect(await manager.execute(91, tunneled.id, 'PING')).toMatchObject({ rows: [['PONG']] })
        await manager.disconnect(91, tunneled.id)
        const retry = await manager.reconnect(91, tunneled.id)
        expect(await manager.execute(91, retry.id, 'PING')).toMatchObject({ rows: [['PONG']] })
        await manager.closeOwner(91)
        await expect(
          manager.connect(91, {
            type: 'redis',
            name: 'bad target',
            host: '127.0.0.1',
            port: 1,
            sshProfileId: 'saved-ssh',
          }),
        ).rejects.toThrow()
      } finally {
        await manager.closeOwner(91)
        await sshFixture.close()
      }
      await setup.sendCommand(['SET', Buffer.from([0xff]), 'binary-key'])
      await setup.set('�', 'text-key')
      await expect(request({ kind: 'scan', database: 0, count: 1000 })).rejects.toThrow(/非 UTF-8/)
      expect(await setup.get('�')).toBe('text-key')
      await request({
        kind: 'member',
        database: 0,
        key: 'hash:sample',
        collection: 'hash',
        operation: 'add',
        member: 'gamma',
        value: 'three',
      })
      await expect(
        request({
          kind: 'member',
          database: 0,
          key: 'hash:sample',
          collection: 'hash',
          operation: 'add',
          member: 'gamma',
          value: 'overwrite',
        }),
      ).rejects.toThrow(/存在/)
      await request({
        kind: 'member',
        database: 0,
        key: 'hash:sample',
        collection: 'hash',
        operation: 'update',
        member: 'gamma',
        value: 'updated',
        expected: 'three',
      })
      await expect(
        request({
          kind: 'member',
          database: 0,
          key: 'hash:sample',
          collection: 'hash',
          operation: 'remove',
          member: 'gamma',
          expected: 'three',
        }),
      ).rejects.toThrow(/修改/)
      await request({
        kind: 'member',
        database: 0,
        key: 'list:sample',
        collection: 'list',
        operation: 'update',
        index: 0,
        value: 'changed',
        expected: 'a',
      })
      await request({
        kind: 'member',
        database: 0,
        key: 'list:sample',
        collection: 'list',
        operation: 'push-tail',
        value: 'tail',
      })
      await request({
        kind: 'member',
        database: 0,
        key: 'list:sample',
        collection: 'list',
        operation: 'pop-tail',
        expected: 'tail',
      })
      expect(await setup.lRange('list:sample', 0, -1)).toEqual(['changed', 'b', 'c'])
      await request({
        kind: 'member',
        database: 0,
        key: 'set:sample',
        collection: 'set',
        operation: 'add',
        member: 'added',
      })
      await request({
        kind: 'member',
        database: 0,
        key: 'set:sample',
        collection: 'set',
        operation: 'remove',
        member: 'added',
      })
      expect(Number(await setup.sIsMember('set:sample', 'added'))).toBe(0)
      await request({
        kind: 'member',
        database: 0,
        key: 'zset:sample',
        collection: 'zset',
        operation: 'update',
        member: 'member',
        score: '2.5',
        expected: '1.5',
      })
      expect(Number(await setup.zScore('zset:sample', 'member'))).toBe(2.5)
      await setup.expire('hash:sample', 300)
      await request({
        kind: 'member',
        database: 0,
        key: 'hash:sample',
        collection: 'hash',
        operation: 'remove',
        member: 'gamma',
        expected: 'updated',
      })
      expect(await setup.ttl('hash:sample')).toBeGreaterThan(0)
      await expect(
        request({
          kind: 'member',
          database: 0,
          key: 'hash:sample',
          collection: 'set',
          operation: 'remove',
          member: 'alpha',
        }),
      ).rejects.toThrow(/类型/)
      await setup.sendCommand(['HSET', 'hash:sample', Buffer.from([0xff]), 'binary'])
      expect(await request({ kind: 'read', database: 0, key: 'hash:sample' })).toMatchObject({
        binaryMembers: true,
      })
    } finally {
      await adapter?.close()
      if (setup.isOpen) setup.destroy()
      processHandle.kill('SIGTERM')
      await stopped
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000,
)
