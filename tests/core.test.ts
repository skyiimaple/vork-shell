import { describe, expect, it } from 'vitest'
import { runSqlite } from '../src/main/sqlite'
import { parseRedisCommand, validateConnection } from '../src/main/validation'
import { DatabaseSync } from 'node:sqlite'

describe('SQLite execution', () => {
  it('executes writes once, preserves null and large integers, and caps results', () => {
    const db = new DatabaseSync(':memory:')
    runSqlite(db, 'CREATE TABLE items (id INTEGER, value TEXT)')
    runSqlite(db, 'INSERT INTO items VALUES (9007199254740993, NULL)')
    const result = runSqlite(db, 'SELECT * FROM items')
    expect(result.columns).toEqual(['id', 'value'])
    expect(result.rows).toEqual([['9007199254740993', null]])
    const limited = runSqlite(
      db,
      'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<10) SELECT n FROM x',
      3,
    )
    expect(limited.rows).toHaveLength(3)
    expect(limited.truncated).toBe(true)
    db.close()
  })
  it('rejects multiple statements rather than silently executing only the first', () => {
    const db = new DatabaseSync(':memory:')
    expect(() => runSqlite(db, 'SELECT 1; SELECT 2')).toThrow(/单条/)
    expect(runSqlite(db, "SELECT ';' AS value").rows).toEqual([[';']])
    db.close()
  })
})

describe('connection and command validation', () => {
  it('parses quoted Redis arguments and rejects unfinished quotes', () => {
    expect(parseRedisCommand('SET greeting "hello world"')).toEqual([
      'SET',
      'greeting',
      'hello world',
    ])
    expect(parseRedisCommand("SET x ''")).toEqual(['SET', 'x', ''])
    expect(() => parseRedisCommand('SET x "oops')).toThrow()
    expect(() => parseRedisCommand('')).toThrow()
  })
  it('rejects invalid ports and unsupported connection types', () => {
    expect(() =>
      validateConnection({
        type: 'ssh',
        name: 'test',
        host: 'localhost',
        port: -1,
        username: 'test',
      }),
    ).toThrow()
    expect(() => validateConnection({ type: 'unknown', name: 'test' })).toThrow()
    expect(validateConnection({ type: 'sqlite', name: 'local', path: ':memory:' }).type).toBe(
      'sqlite',
    )
  })
})
