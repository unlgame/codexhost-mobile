# codexhost-mobile

[![Build CodexHostMobile Android APK](https://github.com/unlgame/codexhost-mobile/actions/workflows/build-android.yml/badge.svg)](https://github.com/unlgame/codexhost-mobile/actions/workflows/build-android.yml)
[![Secret Guard](https://github.com/unlgame/codexhost-mobile/actions/workflows/secret-guard.yml/badge.svg)](https://github.com/unlgame/codexhost-mobile/actions/workflows/secret-guard.yml)
[![GitHub Release](https://img.shields.io/github/v/release/unlgame/codexhost-mobile)](https://github.com/unlgame/codexhost-mobile/releases/latest)
[![Apache-2.0](https://img.shields.io/github/license/unlgame/codexhost-mobile)](LICENSE)
![平台](https://img.shields.io/badge/platform-Android-111111)

**把手机变成 Windows 上 codex-host 的外部 harness 终端。**

`codexhost-mobile` 是一个 Android 客户端：手机装上 APK，手填一次 Windows 网关地址，
就能在手机上查看、继续和管理跑在 Windows 上的真实 Codex 工作流。它不是把终端页面
缩小塞进 WebView，也不维护一套模拟 Codex 的聊天协议——前端针对触控重新设计，
业务数据仍来自真实的 codex-host `AppServerHost`。

[快速开始](#快速开始) · [系统架构](#系统架构) · [运行模式](#运行模式) ·
[签名与密钥](#签名与密钥) · [项目结构](#项目结构) · [与上游的关系](#与上游的关系)

> 本项目是独立开源项目，与 OpenAI 官方没有隶属关系。

---

## 快速开始

### 1. Windows 前置条件

- Windows 主机上**正在运行 codex-host**（`AppServerHost` 已就绪，命名管道可连接）。
- 同一台 Windows 主机上已启动本仓库的网关。
- 手机与 Windows 主机处于同一网络，且防火墙放行了网关监听端口。

如果 codex-host 没有在运行，网关无法转发请求，App 会显示主机不可用。

### 2. 安装 APK

从 [GitHub Releases](https://github.com/unlgame/codexhost-mobile/releases/latest) 下载：

```text
CodexHostMobile-v<version>.apk
CodexHostMobile-v<version>.apk.sha256
```

下载后先校验完整性，再安装。首次安装需要在 Android 系统设置里允许本应用
「安装未知应用」；App 不支持静默安装。详细步骤见
[`install.md`](install.md)。

### 3. 首次配置

打开 App，进入「设备设置」，**手动填写** Windows 网关的完整地址（形如
`http://<Windows-主机地址>:<网关端口>/?token=<访问口令>`，具体值由你启动网关时决定）。

保存后 App 会自动探测 `/api/host`，完成一次握手验证，成功后即可在会话列表中看到
该主机的项目与会话。地址与访问口令只保存在手机本地存储中，不会提交到本仓库。

> 本客户端**不使用二维码配对**，避免把网关地址和访问口令暴露给摄像头、截图和日志。

---

## 系统架构

```mermaid
flowchart LR
    A["安卓 APK<br/>codexhost-mobile"]
    A -->|"HTTP API + WebSocket"| W["Windows 网关"]
    W -->|"codexhost 模式"| B["codexhost 小桥"]
    B -->|"命名管道"| H["codex-host<br/>AppServerHost"]
    H --> S["本机会话与运行时"]
```

数据流向说明：

| 组件 | 职责 |
| --- | --- |
| 安卓 APK | 触控优化的前端，只负责展示与交互，不固化后端地址 |
| Windows 网关 | 提供静态前端、校验访问口令、提供控制面，并在客户端 WebSocket 与 codexhost 小桥之间双向转发消息 |
| codexhost 小桥 | 把网关的转发请求接到本机 codex-host 通道上 |
| 命名管道 | 本机进程间通信，不暴露到网络 |
| AppServerHost | 真实的 Codex 运行时，持有会话、项目与工具调用 |

网关**不改写** codex-host 的业务协议，不复制或长期保存会话内容，也不建立第二套
会话数据库。

---

## 运行模式

### `CODEX_APP_SERVER_MODE=codexhost`（本仓库默认）

这是 codexhost 模式的入口。网关把上游指向本机的 codex-host 通道，经由命名管道
连接到 `AppServerHost`，由 codex-host 自行管理会话生命周期。

```bash
CODEX_APP_SERVER_MODE=codexhost \
codexhost-mobile start
```

使用该模式前请确认 codex-host 已在 Windows 主机上运行，否则网关启动后会一直报
上游不可用。

### `managed`

网关自行启动并管理一个仅监听本机回环通道的 app-server 实例。适用于本机开发调试，
不经过 codex-host。

### `external`

连接一个已经在运行的 app-server，网关不管理其生命周期。

### `gateway-only`

APK 已内置前端时，后端只提供控制面与 WebSocket，根路径返回 `404`。
云端构建产出的 APK 属于这种形态。

---

## 签名与密钥

Android 出包使用 **release 签名**，keystore 只来自 GitHub Secrets，**永不入库**。

| Secret | 用途 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的单行 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | 打开 keystore 的 store 口令 |
| `ANDROID_KEY_ALIAS` | 证书条目别名 |
| `ANDROID_KEY_PASSWORD` | 使用私钥签名的 key 口令 |

配置位置：仓库 **Settings → Secrets and variables → Actions**。
四个 Secret 缺任何一个，构建都会明确失败，不会退化成 debug 签名。

> **keystore 与口令永不入库、永不进日志、永不在 issue 或 PR 贴出、永不提交到 fork。**
> 一旦泄漏必须重新生成并轮换密钥。Android 签名无法吊销，只能靠升级覆盖。

详细说明：

- [`docs/RELEASE.md`](docs/RELEASE.md) —— 签名与出包全流程、产物下载、泄漏处置
- [`docs/SECRETS.md`](docs/SECRETS.md) —— 四个 Secret 的用途、配置与轮换步骤
- [`docs/FORK.md`](docs/FORK.md) —— fork 后如何构建属于自己的 APK
- [`docs/android-signing.md`](docs/android-signing.md) —— 本地生成 keystore 与本地校验签名
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) —— 改名与 Android 化改动记录

`.github/workflows/secret-guard.yml` 会在每次 push / PR 自动扫描被跟踪文件，
一旦发现疑似签名密钥入库就让流水线失败。

---

## 项目结构

```text
codexhost-mobile/
├── bin/                  # CLI 入口
├── src/                  # 前端：V2 客户端、会话恢复、分页、列表加载、UI
├── server/               # 网关、进程管理、项目目录读取、codexhost 小桥
├── protocol/             # app-server V2 协议基准与生成物
├── tests/                # 协议、服务端、UI、CI 与移动端测试
├── docs/                 # 设计、签名、Secrets、fork 与更新记录
└── .github/workflows/    # Android 出包流水线与密钥守卫
```

---

## 与上游的关系

本仓库是 [`loock-ai/codex-mobile`](https://github.com/loock-ai/codex-mobile) 的
下游分支。上游提供移动优先的 Codex Remote 客户端与网关通用能力；本仓库在此之上做了
Android 化、release 签名出包与密钥安全改造，并把产品定位收敛为
「Windows codex-host 的外部 harness 终端」。

主要差异：

- 只发布 Android APK，不再发布 iOS IPA 与 npm 包；
- 应用包名与品牌改为 `codexhost-mobile` / `ai.unlgame.codexhostmobile`；
- 增加 release 签名、密钥守卫与 `docs/` 下的签名/Secrets/fork 文档；
- 运行模式收敛到 `CODEX_APP_SERVER_MODE=codexhost`。

上游仍在维护的通用 Web 功能未被删除，只是本仓库的分发渠道已切换为
GitHub Releases 上的签名 APK。

---

## 安全与仓库边界

- 网关非回环监听必须配置访问口令；当前方案适用于可信局域网。
- 跨不可信网络使用时，应额外增加 HTTPS、可信反向代理和正式身份认证。
- 公开仓库与正式构建产物不包含局域网地址、访问口令、Codex 登录态、API 密钥、
  本机会话、用户项目内容或移动端签名材料。
- App 中保存的主机地址与访问口令位于手机本地存储，不会提交到本仓库。

---

## 致谢

Android 原生容器基于第三方开源项目 [PakePlus](https://github.com/Sjj1024/PakePlus-Android)
构建，前端资源由其打包为 APK。本项目对其构建产物做了 Manifest 权限裁剪、
`allowBackup=false`、FileProvider、签名注入与更新地址收敛等安全加固。
感谢上游项目与 PakePlus 的作者。

---

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。
