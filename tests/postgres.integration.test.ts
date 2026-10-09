import { it, expect } from 'vitest'
import { openDatabase } from '../src/main/adapters'
it.runIf(Boolean(process.env.VORK_POSTGRES_PORT))(
  'executes PostgreSQL scripts and returns only the final result',
  async () => {
    const adapter = await openDatabase(
      {
        type: 'postgresql',
        name: 'test',
        host: '127.0.0.1',
        port: Number(process.env.VORK_POSTGRES_PORT),
        username: 'vork',
        password: process.env.VORK_POSTGRES_PASSWORD || 'vork_test_only',
        database: 'vork_test',
      },
      () => {},
    )
    try {
      const result = await adapter.execute("SELECT 1 AS first; SELECT 'a;b' AS last, 2 AS value;")
      expect(result.columns).toEqual(['last', 'value'])
      expect(result.rows).toEqual([['a;b', 2]])
      const ddl = await adapter.execute('SELECT 3; CREATE TEMP TABLE script_test (id integer);')
      expect(ddl.columns).toEqual([])
      expect(ddl.rows).toEqual([])
      await expect(adapter.execute('SELECT invalid_column; SELECT 2;')).rejects.toThrow()
      expect((await adapter.execute('SELECT 4 AS value')).rows).toEqual([[4]])
    } finally {
      await adapter.close()
    }
  },
)
