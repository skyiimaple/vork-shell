# 外键管理

在「查看结构 → 外键」查看字段映射、目标表、更新/删除规则和定义。点击「新建外键」，填写名称及目标数据库/Schema、目标表，读取目标字段后按顺序映射字段。支持最多32对字段，源/目标数量必须相同且不能重复。

更新和删除规则支持 NO ACTION、RESTRICT、CASCADE、SET NULL，SQLite/PostgreSQL 还支持 SET DEFAULT。字段类型、父表主键/唯一键、NULL/default 兼容性及已有数据最终由数据库校验。规则影响后续写入；仅删除外键不会删除数据或表。

每次先预览 DDL，再确认执行。MySQL/PostgreSQL 使用原生 ALTER；创建时同时保存源表和目标表结构签名，目标表变化会要求重新预览。MySQL 当前要求两表使用 InnoDB，且连接 `foreign_key_checks=1`；预览和执行都复查，避免其他引擎忽略定义或关闭检查后跳过校验。MySQL DDL 可能隐式提交。

SQLite 使用事务性重建，保留数据、其他约束及依赖对象。具名表级外键和未命名内联外键都可以删除，复合键按顺序处理。删除根据服务器从原建表语句解析出的稳定标识执行，不将 PRAGMA 的序号拼进 SQL。无法可靠解析的定义保持只读。SQLite 外键不能跨附加数据库；提交后的外键检查必须通过，其他尚未修复的外键问题也会阻止提交。移除错误外键可以修复其造成的问题而保留原行。

SQLite 保留连接原本的外键开关，后续写入是否检查仍取决于该连接设置；工具不会永久替用户切换。其余重建限制见 [SQLite 重建表](SQLITE-REBUILD.md)。预览令牌一次性使用、5分钟过期。当前提供创建和删除，原地编辑、多个约束合并变更，以及 DEFERRABLE/MATCH/NOT VALID 等高级选项表单仍需补齐。

单元测试位于 `tests/sqlite-foreign-keys.test.ts` 和 `tests/schema-foreign-keys.test.ts`，验证内联/具名/复合解析、原有约束保留、创建不先写入、规则生效、无效数据回滚和删除后的数据保留。真实 MySQL/PostgreSQL 测试位于 `tests/schema-foreign-keys.integration.test.ts`，还覆盖目标结构冲突、关闭检查和不支持引擎。

`pnpm test:schema-tools` 验证 SQLite 桌面复合字段映射、预览、级联和删除；`pnpm test:schema-column-edit` 在两种专用 Docker SQL 服务上验证同样的完整桌面流程，并保留字段编辑回归。
