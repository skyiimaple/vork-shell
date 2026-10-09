import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BSON, MongoClient } from 'mongodb'
import { randomUUID } from 'node:crypto'
import { MongoBrowser } from '../src/main/mongodb'
import { SessionManager } from '../src/main/sessions'
import { ProfileStore } from '../src/main/profiles'
import { exportConnections } from '../src/main/connection-export'
import { parseConnectionImport } from '../src/main/connection-import'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const port = Number(process.env.VORK_MONGODB_TEST_PORT)
describe.skipIf(!port)('real MongoDB browser', () => {
  const database = 'vork_test_' + randomUUID().replaceAll('-', '')
  let client: MongoClient, browser: MongoBrowser
  beforeAll(async () => {
    client = await new MongoClient(`mongodb://127.0.0.1:${port}`, {
      serverSelectionTimeoutMS: 5000,
    }).connect()
    browser = new MongoBrowser(client, database)
    await client
      .db(database)
      .collection('items')
      .insertMany(
        Array.from({ length: 55 }, (_, n) => ({
          n,
          name: '中文文档 ' + n,
          large: BSON.Long.fromString('9007199254740993'),
          date: new Date(0),
        })),
      )
    await client.db(database).collection('items').createIndex({ name: 1 })
  })
  afterAll(async () => {
    await client?.db(database).dropDatabase()
    await client?.close()
  })
  const find = () =>
    browser.request({
      kind: 'find',
      database,
      collection: 'items',
      filter: '{}',
      sort: '{"n":1}',
      page: 0,
      pageSize: 50,
    })
  it('lists databases, collections, indexes and pages with BSON preserved', async () => {
    expect(await browser.request({ kind: 'databases' })).toMatchObject({
      names: expect.arrayContaining([database]),
    })
    expect(await browser.request({ kind: 'collections', database })).toMatchObject({
      names: ['items'],
    })
    expect(await browser.request({ kind: 'indexes', database, collection: 'items' })).toMatchObject(
      { documents: expect.arrayContaining([expect.stringContaining('name_1')]) },
    )
    const result = await find()
    expect(result.kind).toBe('documents')
    if (result.kind !== 'documents') throw Error('response')
    expect(result.documents).toHaveLength(50)
    expect(result.hasNext).toBe(true)
    expect(result.documents[0]).toContain('9007199254740993')
    expect(result.documents[0]).toContain('$oid')
    const next = await browser.request({
      kind: 'find',
      database,
      collection: 'items',
      filter: '{}',
      page: 1,
      pageSize: 50,
    })
    expect(next).toMatchObject({ documents: expect.any(Array), hasNext: false })
    if (next.kind === 'documents') expect(next.documents).toHaveLength(5)
  })
  it('inserts, replaces and deletes documents using immutable server snapshots', async () => {
    await browser.request({
      kind: 'insert',
      database,
      collection: 'writes',
      document: '{"_id":"fixed","name":"before","big":{"$numberLong":"9007199254740993"}}',
    })
    const page = await browser.request({
      kind: 'find',
      database,
      collection: 'writes',
      filter: '{}',
      page: 0,
      pageSize: 50,
    })
    if (page.kind !== 'documents') throw Error('response')
    await expect(
      browser.request({
        kind: 'replace',
        snapshotId: page.snapshotId,
        rowIndex: 0,
        document: '{"_id":"changed"}',
      }),
    ).rejects.toThrow(/_id/)
    const doc = JSON.parse(page.documents[0])
    doc.name = 'after'
    await expect(
      browser.request({
        kind: 'replace',
        snapshotId: page.snapshotId,
        rowIndex: 0,
        document: JSON.stringify(doc),
      }),
    ).resolves.toMatchObject({ affected: 1 })
    expect(
      (
        await client
          .db(database)
          .collection('writes')
          .findOne({ _id: 'fixed' as never })
      )?.name,
    ).toBe('after')
    await expect(
      browser.request({ kind: 'delete', snapshotId: page.snapshotId, rowIndex: 0 }),
    ).rejects.toThrow(/失效/)
    const refreshed = await browser.request({
      kind: 'find',
      database,
      collection: 'writes',
      filter: '{}',
      page: 0,
      pageSize: 50,
    })
    if (refreshed.kind !== 'documents') throw Error('response')
    await browser.request({ kind: 'delete', snapshotId: refreshed.snapshotId, rowIndex: 0 })
    expect(await client.db(database).collection('writes').countDocuments()).toBe(0)
  })
  it('refuses stale edits when another client changes a document', async () => {
    const result = await find()
    if (result.kind !== 'documents') throw Error('response')
    const original = BSON.EJSON.parse(result.documents[0])
    await client
      .db(database)
      .collection('items')
      .updateOne({ _id: original._id }, { $set: { name: 'external edit' } })
    await expect(
      browser.request({
        kind: 'replace',
        snapshotId: result.snapshotId,
        rowIndex: 0,
        document: result.documents[0],
      }),
    ).rejects.toThrow(/其他客户端/)
    await expect(
      browser.request({ kind: 'delete', snapshotId: result.snapshotId, rowIndex: 0 }),
    ).rejects.toThrow(/其他客户端/)
  })
  it('detects case-only external changes even with case-insensitive collection collation', async () => {
    await client
      .db(database)
      .createCollection('collated', { collation: { locale: 'en', strength: 2 } })
    await client.db(database).collection('collated').insertOne({ name: 'before' })
    const result = await browser.request({
      kind: 'find',
      database,
      collection: 'collated',
      filter: '{}',
      page: 0,
      pageSize: 50,
    })
    if (result.kind !== 'documents') throw Error('response')
    await client
      .db(database)
      .collection('collated')
      .updateOne({}, { $set: { name: 'BEFORE' } })
    await expect(
      browser.request({
        kind: 'replace',
        snapshotId: result.snapshotId,
        rowIndex: 0,
        document: result.documents[0],
      }),
    ).rejects.toThrow(/其他客户端/)
    await expect(
      browser.request({ kind: 'delete', snapshotId: result.snapshotId, rowIndex: 0 }),
    ).rejects.toThrow(/其他客户端/)
  })
  it('authenticates with a separate authSource and rejects incorrect credentials', async () => {
    await client.db(database).command({
      createUser: 'reader',
      pwd: 'mongo-test-secret',
      roles: [{ role: 'readWrite', db: database }],
    })
    const manager = new SessionManager(
      () => {},
      async () => true,
    )
    const config = {
      type: 'mongodb' as const,
      name: 'authenticated',
      host: '127.0.0.1',
      port,
      username: 'reader',
      password: 'mongo-test-secret',
      authSource: database,
      database,
    }
    const session = await manager.connect(1, config)
    await expect(
      manager.mongoRequest(1, session.id, { kind: 'collections', database }),
    ).resolves.toMatchObject({ names: expect.arrayContaining(['items']) })
    await manager.disconnect(1, session.id)
    await expect(manager.connect(1, { ...config, password: 'incorrect' })).rejects.toThrow()
    await client.db(database).command({ dropUser: 'reader' })
  })
  it('bounds large results and requires the session owner for IPC requests', async () => {
    await client
      .db(database)
      .collection('large')
      .insertOne({ text: 'x'.repeat(5 * 1024 * 1024) })
    expect(
      await browser.request({
        kind: 'find',
        database,
        collection: 'large',
        filter: '{}',
        page: 0,
        pageSize: 50,
      }),
    ).toMatchObject({ documents: [], truncated: true })
    const manager = new SessionManager(
      () => {},
      async () => true,
    )
    const session = await manager.connect(1, {
      type: 'mongodb',
      name: 'test',
      host: '127.0.0.1',
      port,
      database,
    })
    await expect(manager.mongoRequest(2, session.id, { kind: 'databases' })).rejects.toThrow(/无权/)
    await expect(manager.mongoRequest(1, session.id, { kind: 'info' })).resolves.toMatchObject({
      kind: 'info',
    })
    await manager.disconnect(1, session.id)
    await expect(manager.mongoRequest(1, session.id, { kind: 'databases' })).rejects.toThrow(/关闭/)
  })
})
it('persists authSource, encrypts credentials and round trips a credential-free export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-mongodb-profile-'))
  try {
    const cipher = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 42)),
      decryptString: (b: Buffer) => Buffer.from(b.map((v) => v ^ 42)).toString(),
    }
    const config = {
      type: 'mongodb' as const,
      name: 'mongo',
      host: 'localhost',
      port: 27017,
      username: 'reader',
      password: 'test-secret',
      authSource: 'users',
      database: 'app',
    }
    await new ProfileStore(directory, cipher).save(config)
    expect(await readFile(join(directory, 'connections.json'), 'utf8')).not.toContain('test-secret')
    const [profile] = await new ProfileStore(directory, cipher).list()
    expect(profile).toMatchObject(config)
    const exported = exportConnections([profile])
    expect(exported).not.toContain('test-secret')
    expect(parseConnectionImport(exported)[0].config).toMatchObject({
      type: 'mongodb',
      authSource: 'users',
      database: 'app',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
