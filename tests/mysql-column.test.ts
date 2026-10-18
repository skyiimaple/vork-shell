import { it, expect } from 'vitest'
import { rewriteMysqlColumn } from '../src/main/mysql-column'
it('preserves original defaults, comments, collations and update attributes', () => {
  const ddl =
    "CREATE TABLE `t` (`id` int NOT NULL AUTO_INCREMENT, `title` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'NOT NULL, x' COMMENT 'NULL, keep', `stamp` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (`id`)) ENGINE=InnoDB"
  expect(rewriteMysqlColumn(ddl, 'title', 'varchar(40)', { type: 'VARCHAR(100)' }, false)).toBe(
    "`title` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'NOT NULL, x' COMMENT 'NULL, keep'",
  )
  expect(rewriteMysqlColumn(ddl, 'title', 'varchar(40)', { nullable: true }, false)).toContain(
    "COLLATE utf8mb4_bin NULL DEFAULT 'NOT NULL, x' COMMENT 'NULL, keep'",
  )
  expect(rewriteMysqlColumn(ddl, 'stamp', 'timestamp', { nullable: false }, false)).toBe(
    '`stamp` timestamp NOT NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP',
  )
  expect(rewriteMysqlColumn(ddl, 'id', 'int', { type: 'BIGINT' }, false)).toBe(
    '`id` BIGINT NOT NULL AUTO_INCREMENT',
  )
})
it('handles identifiers and strings containing parentheses, commas and escaped quotes', () => {
  const ddl =
    "CREATE TABLE `a(b` (`odd``name` enum('a,b','c)') DEFAULT 'it\\'s,NULL', `other` text DEFAULT ('NOT NULL,()'))"
  expect(rewriteMysqlColumn(ddl, 'odd`name', "enum('a,b','c)')", { nullable: false }, false)).toBe(
    "`odd``name` enum('a,b','c)') NOT NULL DEFAULT 'it\\'s,NULL'",
  )
  const mode =
    "CREATE TABLE `t` (`v` varchar(30) DEFAULT 'back\\slash''quote,()' COMMENT 'x',`b` int)"
  expect(rewriteMysqlColumn(mode, 'v', 'varchar(30)', { nullable: false }, true)).toContain(
    "NOT NULL DEFAULT 'back\\slash''quote,()' COMMENT 'x'",
  )
  expect(() => rewriteMysqlColumn(mode, 'missing', 'int', { nullable: true }, true)).toThrow()
  expect(() => rewriteMysqlColumn(mode, 'v', 'text', { nullable: true }, true)).toThrow()
})
it('inserts nullability after charset/collation when the original clause omits NULL', () => {
  const ddl =
    "CREATE TABLE `t` (`v` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'keep')"
  expect(rewriteMysqlColumn(ddl, 'v', 'varchar(80)', { nullable: false }, false)).toBe(
    "`v` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'keep'",
  )
})
