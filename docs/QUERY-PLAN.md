# 查询执行计划

在 SQL 编辑器输入语句，点击工具栏「执行计划」图标。存在选中内容时优先分析选中的 SQL。也可在弹窗中修改 SQL，点击「生成执行计划」更新。

- SQLite：使用 `EXPLAIN QUERY PLAN`，按节点/父节点还原访问路径。
- MySQL：使用 `EXPLAIN FORMAT=JSON`，展开查询块、连接、扫描和成本信息。
- PostgreSQL：使用 `EXPLAIN (FORMAT JSON, VERBOSE TRUE, COSTS TRUE)`，展示节点树、估算成本、行数、索引和过滤条件。

左侧可以展开/收起计划树，选中节点后右侧显示属性。可以切换原始计划或复制完整计划 JSON。修改 SQL 后会标记计划已过时，需要重新生成。

只接受单条原始查询或数据操作语句；多语句脚本、控制命令、已有 EXPLAIN/ANALYZE 前缀会被拒绝。此功能不启用 ANALYZE，也不提供实际耗时指标。成本为优化器内部单位，不是毫秒；全表扫描不一定意味着优化器选择不合理。SQLite 不提供成本估算。

解析失败、计划截断或数据库未返回节点时有明确提示，并保留原始响应。计划解析最多2000个节点、64层；不支持的格式可以查看原始结果。读取期间可明确选择「停止并断开」，沿用现有查询取消行为并断开当前 Query 连接。

验证：`pnpm test:query-plan` 使用独立 SQLite 文件和临时用户目录，通过真实 Electron 验证索引计划树、原始计划、尾部 SQL 注释、解释 INSERT 不写入和拒绝多语句。`tests/query-plan.integration.test.ts` 通过专用 MySQL/PostgreSQL 测试库验证 JSON 计划和写入语句未执行。

文档依据：[SQLite](https://www.sqlite.org/eqp.html)、[MySQL](https://dev.mysql.com/doc/refman/8.4/en/explain.html)、[PostgreSQL](https://www.postgresql.org/docs/current/sql-explain.html)。
