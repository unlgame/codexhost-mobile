# 本地开发

本仓库的定位是把手机作为外部 harness 终端连到 Windows 上的 codex-host，
因此本地开发主要在 Windows 上进行。`npm run dev` 由 `bin/dev.mjs` 驱动，
macOS / Linux / Windows 行为一致。

## 启动

```bash
npm install
npm run dev
```

会同时拉起两个进程：

| 进程 | 端口 | 说明 |
| --- | --- | --- |
| `gateway` | 18766 | `server/index.ts`，`tsx watch` 热重启 |
| `vite` | 5173 | 前端开发服务器，`/api` 与 `/ws` 代理到 18766 |

任一方退出时会通过 `concurrently --kill-others` 一并结束另一个。

## 网关环境文件

开发时网关需要的 `CODEX_MOBILE_TOKEN` 等变量来自环境文件，按平台读取：

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\CodexHostWeb\gateway.env` |
| macOS | `~/Library/Application Support/CodexHostWeb/gateway.env` |
| Linux | `$XDG_CONFIG_HOME/CodexHostWeb/gateway.env`（默认 `~/.config`） |

文件是 `KEY=VALUE` 格式，支持注释、空行、`export` 前缀与成对引号：

```ini
# 本地网关环境
CODEX_MOBILE_TOKEN=dev-token-123
CODEX_APP_SERVER_MODE=codexhost
```

两点需要注意：

- **真实环境变量优先**。环境文件里已有的键不会覆盖 shell 里已设的值，
  所以一次性覆盖仍然生效。
- **macOS 兼容旧路径**。除 `CodexHostWeb` 外也会找历史上的
  `CodexMobileWeb` 目录，既有开发机升级后不会突然读不到原来的文件。

找不到环境文件只会告警不退出，此时网关以空口令运行。也可以用
`CODEX_MOBILE_ENV_FILE` 显式指定路径。

## 选择运行模式

`CODEX_APP_SERVER_MODE` 决定网关怎么拿到 app-server：

| 值 | 行为 |
| --- | --- |
| `managed`（默认） | 网关自己拉起并管理 `codex` app-server，需要本机装有 codex CLI |
| `codexhost` | 网关上游指向本机 codex-host 通道，经命名管道复用同一条 Host 会话 |

在 Windows 上如果没有安装 codex CLI，`managed` 模式会在启动时报
`无法启动 codex app-server：spawn codex ENOENT` 并退出；改用 `codexhost`
即可，前提是 codex-host 已在运行并发布了
`%LOCALAPPDATA%\codexhost\remote-control-bridge-v1.json`。

排查环境文件是否生效可以用干跑模式，它只报告解析结果、不启动子进程：

```bash
CODEX_MOBILE_DEV_DRY_RUN=1 node bin/dev.mjs
```

## 常用命令

```bash
npm run dev            # 网关 + Vite
npm run dev:gateway    # 只起网关
npm run dev:web        # 只起 Vite
npm start              # 以生产模式跑网关（需先 npm run build）
npm test               # vitest
npm run typecheck      # tsc -b
```

## 相关文档

- [FORK.md](FORK.md) — Fork 后构建自己的 APK
- [RELEASE.md](RELEASE.md) — 发布流程
- [../README.md](../README.md) — 运行模式与外部 harness
