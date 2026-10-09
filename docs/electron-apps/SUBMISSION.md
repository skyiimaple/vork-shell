# Electron Apps 提交准备

目标平台暂按 Electron 官网 Apps 展示目录：https://www.electronjs.org/apps/ 。它展示应用，安装包下载与更新仍走应用自己的发布渠道。若用户指其他平台，这份资料不代表对应商店的提交资料。

官方提交指南：https://github.com/electron/apps/blob/main/contributing.md

本目录的 apps/vork-shell 可在满足资格后复制到 electron/apps 仓库同路径。图标使用项目原创终端图标（1024×1024 PNG），YAML 分类为 Developer Tools，界面语言标注 zh-CN。当前不添加未公开的截图链接。

## 提交前检查

- 核实项目实际创建日期：官方要求新应用创建至少20天后再提交。开发日志的最早日期不是项目创建日期证明。
- 将源码和完整 README 发布到公开仓库，README 添加不含真实凭据的应用截图。
- 发布至少一个系统的可下载安装包。当前本地 macOS ARM64 未签名候选包不能标记成已正式上线。
- 核对公开仓库、README、下载链接及图标；需要截图元数据时使用实际公开的 HTTPS 地址。
- 按 electron/apps 的当前贡献规则验证资料并提交。检索时 GitHub 页面显示仅协作者可创建 PR；实际提交前需确认是否仍限制外部贡献。不要将本地资料准备视为官方接收。

## PR 草稿

标题：Add Vork Shell

正文：

Vork Shell provides a unified workspace for SSH terminals and SQLite, MySQL, PostgreSQL, and Redis databases, with SSH tunnels, SFTP transfers, SQL editing, and light/dark themes.

Project: https://github.com/skyiimaple/vork-shell

The app is intended for developers who manage remote servers and databases in one workspace. It uses Electron and provides a Chinese interface.

提交时补充已验证的安装包链接与项目创建日期，不能保留占位内容。

## 当前状态

仅本地准备 YAML、原创图标和 PR 文案；没有提交 PR、上传安装包或改变首版发行标记。正式发行步骤继续见 ../RELEASE.md。
