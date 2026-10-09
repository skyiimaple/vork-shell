# Redis 专用工作区实施计划

依据用户提供的 redis-desktop 仓库 b2feaa8f415d4f6c3f51f624c966718f04316a81，参考 SCAN、按类型查看键值、TTL 与键操作的交互思想，独立实现于当前 Electron 架构。

- [x] 先写游标/集合分页、TTL语义、重命名防覆盖、保留TTL的字符串编辑和键树身份测试，观察失败。
- [x] 独立 Redis 适配器：连接、显式数据库作用域、命令结果和 typed redisRequest。SCAN COUNT 只作为提示，不静默丢弃返回批次。
- [x] 类型化 IPC 与所有权/超时管理，把 Redis 工作区接入会话；避免跨DB缓存、命令与浏览请求相互改变作用域。
- [x] 新建 RedisPanel：键树搜索/加载、TYPE/TTL/size、String/Hash/List/Set/ZSet/Stream 预览、命令控制台与显式键操作；统一深浅主题。
- [x] 单元/真实本地 Redis 集成、桌面验收、类型和构建验证，代码审查；记录实际已验证边界。

原仓库采用旧的 renderer 直连驱动/Element Plus；本项目使用 main 驱动、最小 preload、shadcn-vue 和最新 Vue/TanStack。字符串预览最多64KiB，集合预览分页；超出传输预算时错误提示，不把截断内容作为完整值保存。TTL只接受正整数，清除TTL使用PERSIST，重命名使用RENAMENX。

验收记录（2026-10-05）：vue-tsc 和构建成功，7个测试文件/19个测试通过（含隔离 Redis 8.10.2 与 SSH 真实服务）；Electron 验证键树、值预览、PING、DB切换隔离及深浅主题，截图位于 .artifacts/redis-dark.png 与 redis-light.png。审查发现的非UTF8键名别名风险与分页queryFn动态作用域问题已修复并复查通过。
