# Vork Shell MVP 实施计划

目标：把空仓库变成可运行的 Electron 万能终端，支持创建连接、会话标签、SSH 交互、SQL 结果与 Redis 命令。
架构：main 持有会话与驱动；sandbox preload 暴露有类型的 IPC；renderer 使用 Vue、shadcn-vue、Tailwind 与 TanStack。
依据：/Users/maple/skill/universal-terminal-frontend/SKILL.md。Vite 按已授权回退到 7.3.6，其余依赖核验 npm latest。

- [x] 创建工程、锁文件与三进程构建；验证类型、安装与构建。
- [x] 先写真实 SQLite 查询、类型保真、结果上限和命令解析测试并确认失败；实现 shared/contracts.ts、main/sqlite.ts 和 main/validation.ts。
- [x] 实现会话管理、SQLite worker、MySQL/PostgreSQL/Redis/SSH 适配器；IPC 校验 sender 与会话归属；SSH 首次主机密钥确认与有界输出。
- [x] 创建连接表单、工作区、终端和 SQL/Redis 执行面板；显示真实运行状态与错误，连接配置不持久化密码。
- [x] 完成 SQLite 真实闭环、单元测试、类型检查、生产构建与 Electron 启动检查；代码审查并修复问题。

首个版本不宣称远程服务已验收；需要实际服务器凭据才能完成对应连接验证。查询显式执行且不自动重试，关闭标签清理资源。

主题：深色、亮色、跟随系统；保存偏好，并同步 xterm、表格、表单和所有浮层。

验收结果：9 项单元/集成测试通过；vue-tsc 类型检查通过；三进程生产构建通过；真实 Electron 中 SQLite 查询、隔离设置、深色/亮色/系统主题、偏好恢复和连接对话框通过。MySQL/PostgreSQL/Redis 尚未完成真实服务器验收。
