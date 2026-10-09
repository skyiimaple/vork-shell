# Vork Shell 首版发布

当前版本为 `0.1.0` 首版候选。第7项 SSH 隧道和第8项打包、手动更新基础已实现；正式上线还需要发行证书、公证凭据，以及各平台安装与真实更新验收。不会自动上传或发布。

## 本地候选包

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:mac
node scripts/package-smoke.cjs
```

macOS ARM64 产物在 `release/`：DMG 用于安装，ZIP 用于分发和更新。候选包未签名，在线更新禁用，仅用于内部验收。`package:mac` 使用本机 Electron，其他主机架构会生成对应架构产物。

应用顶部「版本日志」或底部版本号进入用户日志页，支持按日期和内容搜索、深浅主题。独立网页在 `public/changelog.html`，可随安装包提供，离线也能查看。`src/shared/release-history.json` 是唯一日志数据源，日期是开发里程碑；当前没有虚构历史发行版本。

## 正式构建

默认渠道是仓库 `skyiimaple/vork-shell` 的 GitHub Releases。更换渠道时需同步修改 `electron-builder.cjs`，重新构建；不要在客户端填入任意更新地址或私人访问令牌。

在受控构建环境设置 `VORK_ENABLE_UPDATES=1`，配置发行凭据后执行 `pnpm package:release`。构建前检查会拒绝未签名更新包和缺失凭据。不要提交凭据到仓库。

| 平台    | 凭据                                                                                                                                   | 产物                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| macOS   | `CSC_LINK`、`CSC_KEY_PASSWORD`，Developer ID Application 发行证书；`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 公证凭据 | DMG、ZIP、latest-mac.yml、blockmap |
| Windows | `CSC_LINK`、`CSC_KEY_PASSWORD` 代码签名凭据                                                                                            | NSIS EXE、latest.yml、blockmap     |
| Linux   | 当前不要求发行证书                                                                                                                     | AppImage、latest-linux.yml         |

GitHub 手动工作流 `.github/workflows/release.yml` 对应使用 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`、`WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` 和上述 Apple secrets。工作流只构建、保存候选产物，没有发布权限。macOS 和 Windows 缺少凭据会失败，避免产出貌似正式的未签名安装包。

发布前更新 package.json 版本和 release-history.json 版本，核对时间线内容，将 `released` 改为 true，执行 `pnpm release:notes` 生成 CHANGELOG 和独立网页，再构建。首版通过验收后，人工创建同版本 GitHub Release，附上安装包、更新 YAML、blockmap 和 changelog.html；macOS 必须同时附上 ZIP。保留更新元数据中的原始文件名。不要仅上传 DMG。

## 更新交互

日志页由用户点击检查更新，有新版后手动下载，下载完成再点击安装。显示进度和错误，安装前确认并保存工作区、关闭连接。启动、退出和浏览日志不会自动下载或安装；开发与未启用更新的构建明确显示更新不可用。

正式渠道验收需安装已签名旧版本，再发布签名新版本，验证检查、下载进度、断网错误、取消安装确认、重启安装和工作区恢复。当前未执行远端发布，因此未验证完整在线升级链路。

## 验收边界

- 已提供真实 SSH/Redis 隧道生命周期联调和副屏桌面脚本 `pnpm test:release`；没有副屏时隐藏窗口，不抢主屏焦点。真实 Redis 测试设置 `VORK_REDIS_SERVER` 指向本机 redis-server。
- MySQL / PostgreSQL 驱动与绑定参数测试已覆盖，但真实服务集成需单独配置专用测试数据库；当前未提供服务的测试跳过。
- MySQL 使用 SSH 隧道和 TLS 时必须填写证书 DNS 主机名；当前驱动不能可靠校验这条路径中的 IP 证书身份，因此明确拒绝 IP。PostgreSQL / Redis 保留原目标 TLS 身份校验。
- Windows / Linux 工作流已配置，仍需实际运行并在对应系统验证安装、启动、连接和卸载。macOS ARM64 候选验收不能替代跨平台或正式签名验收。

## GitHub 首版下载渠道

首版选择 GitHub Releases，无需提交 Electron Apps。发布资料集中在 `release/github-v0.1.0/`：macOS ARM64 DMG、ZIP、SHA256SUMS、changelog.html，以及 RELEASE-NOTES.md。按未签名预览版（Pre-release）发布，在线更新禁用。

创建 Release 前需提交并推送对应源码，确保标签指向生成安装包的源码版本。当前远端仅有初始提交，不应将安装包关联到仅含 LICENSE 的旧提交。现有 GitHub App 工具不支持 Release/附件上传，可使用 GitHub CLI 或网页完成。

CLI 先运行 `gh auth login --hostname github.com --web`。提交并推送源码后，通过 `gh release create` 指定 v0.1.0 标签、首版源码 commit、`--prerelease`、`--notes-file release/github-v0.1.0/RELEASE-NOTES.md`，并附上 DMG、ZIP、SHA256SUMS、changelog.html。

网页入口：https://github.com/skyiimaple/vork-shell/releases/new 。选择首版源码提交创建 v0.1.0 标签，勾选 Pre-release，粘贴 RELEASE-NOTES.md 并上传上述4个附件。发布后验证匿名访问和下载链接，草稿不是公开下载页。
