import { describe, expect, it } from 'vitest'
import { BSON } from 'mongodb'
import { validateConnection } from '../src/main/validation'
import { parseMongoDocument, validateMongoRequest, mongoClientOptions } from '../src/main/mongodb'
import { profileIdentity } from '../src/shared/connection-identity'
import { encodeWorkspace, decodeWorkspace } from '../src/renderer/src/lib/workspace'
const config = { type: 'mongodb' as const, name: 'Mongo', host: 'localhost', port: 27017 }
describe('MongoDB connection', () => {
  it('supports unauthenticated connections and separate authentication databases', () => {
    expect(validateConnection(config)).toMatchObject(config)
    expect(
      validateConnection({
        ...config,
        username: 'reader',
        password: 'secret',
        authSource: 'admin',
      }),
    ).toMatchObject({ authSource: 'admin' })
    expect(() => validateConnection({ ...config, authSource: 'bad/db' })).toThrow()
    expect(() => validateConnection({ ...config, host: 'localhost?tls=false' })).toThrow()
    expect(() => validateConnection({ ...config, password: 'secret' })).toThrow()
    expect(() => validateConnection({ ...config, sshProfileId: 'ssh' })).toThrow()
    expect(profileIdentity({ ...config, authSource: 'admin' })).not.toBe(
      profileIdentity({ ...config, authSource: 'users' }),
    )
  })
  it('sets timeouts and verified TLS, keeping credentials out of the URI', () => {
    expect(
      mongoClientOptions({
        ...config,
        tls: true,
        username: 'user',
        password: 'p',
        authSource: 'users',
      }),
    ).toMatchObject({
      tls: true,
      authSource: 'users',
      auth: { username: 'user', password: 'p' },
      serverSelectionTimeoutMS: 10000,
      timeoutMS: 25000,
    })
  })
  it('restores MongoDB tabs without persisting document content', () => {
    const session = { id: 'm', name: 'Mongo', type: 'mongodb' as const, target: 'localhost:27017' }
    expect(decodeWorkspace(encodeWorkspace([{ session, sql: 'secret' }], 'm'))?.tabs[0]).toEqual({
      session,
      sql: '',
    })
  })
})
describe('MongoDB request boundary', () => {
  it('preserves ObjectId, dates and 64 bit integers in Extended JSON', () => {
    const doc = parseMongoDocument(
      '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"at":{"$date":{"$numberLong":"0"}},"n":{"$numberLong":"9007199254740993"}}',
    )
    expect(doc._id).toBeInstanceOf(BSON.ObjectId)
    expect(doc.at).toBeInstanceOf(Date)
    expect(doc.n).toBeInstanceOf(BSON.Long)
    expect(String(doc.n)).toBe('9007199254740993')
  })
  it('rejects arrays, scripts, oversized documents and unsafe paging before contacting the server', () => {
    for (const doc of ['[]', 'null', 'db.items.find({})', '"text"', '{'])
      expect(() => parseMongoDocument(doc)).toThrow()
    expect(() => parseMongoDocument(JSON.stringify({ text: 'x'.repeat(1024 * 1024) }))).toThrow()
    expect(() =>
      validateMongoRequest({
        kind: 'find',
        database: 'test',
        collection: 'items',
        filter: '{}',
        sort: '{}',
        page: -1,
        pageSize: 50,
      }),
    ).toThrow()
    expect(() =>
      validateMongoRequest({
        kind: 'find',
        database: 'test',
        collection: 'items',
        filter: '{"$where":"return true"}',
        page: 0,
        pageSize: 50,
      }),
    ).toThrow()
    expect(() => validateMongoRequest({ kind: 'command', database: 'admin' })).toThrow()
    expect(() => validateMongoRequest({ kind: 'collections', database: 'bad/db' })).toThrow()
    expect(() =>
      validateMongoRequest({ kind: 'replace', snapshotId: '', rowIndex: 0, document: '{}' }),
    ).toThrow()
  })
})
