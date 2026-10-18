# AI SQL 助手

SQL 工作区工具栏的星光按钮打开助手，设置页也可配置服务。仅在点击「发送给 AI」时请求模型。

1. 选择服务类型：OpenAI、OpenAI 兼容/本地模型，或 Claude/Anthropic。
2. 填写 API 基础地址（如 `https://api.openai.com/v1`、`https://api.anthropic.com/v1` 或本地服务的 `/v1`）、模型 ID 和服务需要的 Key。模型名称由用户填写，不预设账户可用模型。
3. 选择生成、解释、优化或修复 SQL，核对本次发送的 SQL。修复操作可以修改发送的错误信息。
4. 可选附带已加载的表名/字段；默认不附带。不会读取查询结果作为上下文，不发送连接密码。
5. 回答中的 SQL 可以编辑，点击「替换编辑器内容」只填入文本。点击执行后，还需审查并确认 AI SQL，才会发送数据库。

支持继续追问和清空当前对话。对话仅保存在当前面板内，不跨重启持久化。Key 使用 Electron 系统加密存储，不回传设置界面；同一服务留空保留原 Key，通过明确勾选清除；更换服务类型或服务域名时不会将旧 Key 自动带到新服务。系统加密不可用时拒绝保存 Key，无认证本地服务仍可使用。

可选填写 HTTP 或 HTTPS 代理，只用于连接 AI 服务。代理密码同样使用系统加密存储，不回传设置界面；同一代理留空密码会保留原密码，更换代理主机或端口且留空时不会保留旧密码。系统加密不可用时拒绝保存代理密码，无认证代理仍可使用。代理地址不能包含用户名、密码、路径、查询参数或片段，用户名和密码填写在单独字段。

请求可以取消，90秒超时，不自动重试；每个窗口最多同时进行2个请求。单项输入64 KiB，最多20条对话历史，服务响应最多1 MiB。达到模型输出上限时提示内容可能不完整，并禁用直接替换编辑器。

请求默认使用流式输出，回答会逐步显示；服务若仍返回完整 JSON，则按非流式结果处理。OpenAI 使用 `max_completion_tokens`；兼容/本地服务使用 `max_tokens`；Claude 使用 Messages 协议。自定义服务需提供对应协议。流式过程中不能把尚未结束的 SQL 填入编辑器。

验证：`pnpm test:ai-sql` 使用临时用户数据目录和本机 HTTP 夹具验证配置、流式输出、代理转发、审查、取消执行及确认执行。单元测试覆盖两种协议的流式输出与 JSON 回退、代理认证与不受信任的 TLS 证书、加密接口、取消、超时、响应大小和 HTTP 错误；并不证明任何真实云端账号或模型已可用。

协议依据：[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Claude Messages](https://platform.claude.com/docs/en/api/messages/create)。
