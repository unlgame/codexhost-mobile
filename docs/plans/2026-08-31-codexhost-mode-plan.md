# codexhost 模式实施计划（Windows Host + Android APK）

> 本文件是子代理团队的共享契约。所有结论均已通过阅读源码验证，标注了文件与行号。
> 只读参考仓库：`/f/worksp/claude/codex-host`（不要修改）。

## 0. 背景与最终决策（用户已确认）

- 目标：安卓手机（APK）连接 **Windows 上正在运行的 codex-host**，与桌面端**同一会话**（两机同时改/查看会话）。
- 采用**路线乙**：小桥只对 codex-host 开 **一条** WebSocket 连接（= 一个 `AppServerHost`），多台手机复用到这一条上。
- `codexhost` 模式下由 `server/index.ts` **自动 spawn** 小桥。
- Android 打包沿用 codex-mobile 原有的 PakePlus 方案；**签名密钥本地生成，绝不入库**，云端 CI 构建。
- 仓库将推送到 `https://github.com/unlgame/codexhost-mobile`。
- **二维码配对弃用**（删除 `src/features/backends/GatewayQrScannerSheet.tsx`、`gateway-qr-scanner.ts` 及其引用）。
- harness UI **并入现有 model picker**。
- 两机同时发官方请求，后者收到 `busy` → **toast 提示**（不排队重试）。
- UI 风格/交互逻辑**学习 codex-mobile 现有实现**（即 ChatGPT 官方风格）。
- 用量信息 UI：**点击展开显示**，参考文本：
  ```
  用量
  上下文 7.7% / 1M
  缓存读取 7.6M
  缓存写入 0
  Token 总数 8.1M
  输入 / 输出 424.1k / 102.4k
  会话费用估算 $0.000
  ```

## 1. 已验证的 codex-host 事实

### 1.1 Windows Host 的管道监听（同会话的关键）

`packages/host-runtime/src/run-host-runtime.ts:143-215`：
- `createRemoteControlAppServerPlan()` 生成 `\\.\pipe\codexhost-remote-control-<ownerPid>-<instanceId>`
- `createRemoteAppServerWebSocketListener({ socketPath, createSession })`：**每个 socket 新建一个完整 `AppServerHost`**
- `publishRemoteControlAppServerDescriptor()` 写 `%LOCALAPPDATA%\codexhost\remote-control-bridge-v1.json`

descriptor 结构（`remote-control-app-server.ts:23-28`）：
```json
{ "schemaVersion": 1, "ownerPid": 1234, "pipePath": "\\\\.\\pipe\\codexhost-remote-control-1234-abcd",
  "nodePath": "C:\\...\\node.exe", "runtimePath": "C:\\...\\host-runtime.mjs" }
```
目录 0700、文件 0600、临时文件 + `rename` 原子发布。

### 1.2 帧格式（`remote-app-server.ts:337-380`）

- Host→客户端：`desktopOutput` 按 `\n` 切分，**每帧 = 一条 text WS 消息**
- 客户端→Host：每条 text WS 消息**补 `\n`** 后写入 `desktopInput`
- 二进制帧会被 `close(1003)` 拒绝

→ 与 `server/gateway.ts` 的「逐帧原样转发」**完全兼容，零翻译**。

### 1.3 共享语义

| 线程类型 | 多 socket 是否共享 | 证据 |
|---|---|---|
| 官方 codex 线程 | ✅ 共享 | `official-runtime-scope.ts` 类注释 "Process ownership shared by all AppServerHost clients in one Host deployment"；`official-runtime-owner.ts:72` "One process owner, many native client connections" |
| 外部 harness 线程 | ❌ 不共享 | `app-server-host.ts:623` `this.#externalRuntime` 是实例字段；`external-thread-runtime.ts` 的 `ExternalThread` 持有单个 `session` + 单个 `outputTask`，只泵给创建它的 `#writer` |

→ 所以必须走**路线乙（单上游多路复用）**，让 `ExternalThreadRuntime` 全局唯一。

### 1.4 WS-over-named-pipe 客户端参考实现

`packages/host-runtime/src/remote-official-connection.ts:38-64`：
```ts
new WebSocket("ws://localhost/", {
  createConnection: () => net.createConnection(pipePath),
  maxPayload: 0,            // 必须：历史页可能含大图片
  perMessageDeflate: false, // 必须：native daemon 用 tokio-tungstenite，不提供 permessage-deflate
})
```
`ws` 包已在本仓库 `dependencies` 中。

### 1.5 `busy` 错误

`official-work-gate.ts`：`OfficialWorkGate` 是全局同步闸门，后到者收到 `OfficialAdmissionError`（消息含 `busy`）。UI 做 toast。

### 1.6 harness 路由 = model ref（UI 关键）

`packages/shared-contracts/src/harness-route.ts`：
```
codexhost/plugin-v1@<hex(JSON({ harnessId, model?, thinkingOptionId?, permissionModeId? }))>
```
`app-server-host.ts:416-420`：`model/list` 返回条目带 `modelCarrier: "<harnessId>-transport"`、`selectedHarness`。
→ **harness 切换就是选一个特殊 model ref**，`turn/start` 的 `model` 字段原样透传（`src/App.tsx:1321` 已在做）。

### 1.7 可用 RPC（都在同一条 JSONL 流里，网关无需改动）

- `model/list`（已有）、`permissionProfile/list`、`config/read`、`account/rateLimits/read`（已有）
- `codexhost/thread/inspect` → 按 `owner` discriminated union；external 分支含
  `harnessId / transportModelId / effectiveModel / resolvedModelLabel / effectiveThinkingOptionId /
   availableThinkingOptions / effectivePermissionModeId / history / usage / locked`
- `codexhost/thread/usage/inspect` + 通知 `codexhost/thread/usage/updated`
- `codexhost/thread/model/select`、`codexhost/thread/thinking/select`、`codexhost/thread/permission-mode/select`
- `codexhost/harness/plugins/list`、`codexhost/harness/inspect`、`codexhost/harness/accounts/list`
- `codexhost/thread/ownership/list`

### 1.8 用量字段（`packages/shared-contracts/src/thread-usage.ts`）

`cachedInputTokens` / `cacheWriteInputTokens` / `cacheHitRatePercent` /
`planFiveHourUsedPercent` / `planSevenDayUsedPercent`（均 optional）

## 2. 模块划分（目录隔离，避免并行冲突）

| 负责方 | 只改这些路径 |
|---|---|
| Worker-BRIDGE | `server/codexhost-bridge.ts`（新）、`server/app-server-manager.ts`、`server/index.ts`、`server/codexhost-bridge.test.ts`（新） |
| Worker-UI | `src/**`（含删除 QR 文件）、`tests/**` |
| Worker-ANDROID | `.github/workflows/**`、`docs/**`、`package.json`、`.gitignore`、`README.md`、`install.md` |

## 3. Worker-BRIDGE 规格

新增 `CODEX_APP_SERVER_MODE=codexhost`。

### 3.1 `server/codexhost-bridge.ts`（新文件）

导出 `startCodexHostBridge(options): Promise<{ port, close }>`：

1. 读 `%LOCALAPPDATA%\codexhost\remote-control-bridge-v1.json`
   - `LOCALAPPDATA` 不存在 → 抛错，消息说明"仅在 Windows 上可用"
   - JSON 解析失败 / `schemaVersion !== 1` → 抛错，消息："codex-host descriptor 不受支持（schemaVersion=…），请升级 codexhost-mobile"
   - `pipePath` 不是字符串或不以 `\\.\pipe\codexhost-remote-control-` 开头 → 抛错
   - **绝不自己拼管道名**，只用 descriptor 里的 `pipePath`
2. `ownerPid` 存活检查：`process.kill(pid, 0)`，`EPERM` 视为存活，`ESRCH` → 抛错"codex-host Host Runtime 未运行"
3. 在 `127.0.0.1` 起 `WebSocketServer`（端口默认 `18767`，可用 `CODEXHOST_BRIDGE_PORT` 覆盖）
4. **只接受一条上游连接**：第一个浏览器客户端到来时拨管道；后续客户端复用到同一条上游
5. 上游拨号用 §1.4 的参数
6. 多路复用：
   - 每个下游客户端分配 `downstreamId`（`c1`、`c2`…）
   - 下游→上游：JSON-RPC 请求/通知若有 `id`，把 `id` 改写成 `<downstreamId>:<originalId>` 再转发；记录 `rewrittenId → { client, originalId }`
   - 上游→下游：响应（有 `id` 且匹配记录）→ 还原 `id` 发给原客户端，未知 id → 广播
   - 上游→下游：服务端主动请求（有 `id` + `method`，如审批）→ 路由到"该线程的当前操作方"，无记录则广播；需要把 `id` 同样改写
   - 上游→下游：通知（有 `method` 无 `id`）→ 按 `params.threadId` 扇给订阅者；无 `threadId` 则广播
   - 订阅表：下游发 `thread/start`、`thread/resume`、`thread/read`、`thread/items/list` 时记录 `threadId → Set<client>`
   - 帧边界：上游每条 text 消息就是完整一帧，直接转发；下游同样。**不要重新 split/join**
7. 上游断开 → 关闭所有下游，`close(1011, "codex-host 连接断开")`
8. 下游全部断开 → 保持上游（保留会话），或可配置；默认保持
9. `close()`：先关下游再关上游

### 3.2 `server/app-server-manager.ts`

- `RuntimeConfig.mode` 联合类型加 `"codexhost"`
- `resolveRuntimeConfig()`：`CODEX_APP_SERVER_MODE === "codexhost"` → `{ mode: "codexhost", upstreamPort, upstreamUrl: "ws://127.0.0.1:<bridgePort>" }`
- 新增 `resolveCodexHostBridgePort(env)`（默认 18767）
- **不要动** `startManagedAppServer`、`appServerCommand`、`assertGatewaySecurity`

### 3.3 `server/index.ts`

- `codexhost` 模式：`const bridge = await startCodexHostBridge({...})`，传给 `createGateway` 的 `mode: "external"`、`upstreamUrl`
- 进程退出时 `await bridge.close()`
- `appServerReady` 对 codexhost 模式返回 `true`（小桥已保证连上管道；若拨号失败应在 spawn 阶段就抛错）

### 3.4 测试 `server/codexhost-bridge.test.ts`

用 `vitest`（仓库已有 `test: vitest run`）。至少覆盖：
- descriptor 缺失 / `schemaVersion !== 1` / `pipePath` 非法 / owner 未运行 → 明确错误
- id 改写与还原往返
- 通知按 `threadId` 扇出
- 二进制帧被拒
- 上游断开 → 下游全部关闭

可参考 `tests/` 下现有写法。

## 4. Worker-UI 规格

### 4.1 harness 路由编解码（新文件 `src/app-server/harness-route.ts`）

```ts
export const HARNESS_ROUTE_PREFIX = "codexhost/plugin-v1@";
export interface HarnessRoute { harnessId: string; model?: string; thinkingOptionId?: string; permissionModeId?: string }
export function decodeHarnessRoute(value: unknown): HarnessRoute | null  // 非本协议返回 null；格式非法 throw
export function encodeHarnessRoute(route: HarnessRoute): string
export function harnessRouteLabel(route: HarnessRoute, displayName?: string): string
```
与 `packages/shared-contracts/src/harness-route.ts` 行为一致（hex 编码 JSON、round-trip 校验、长度上限 4096）。
**写单测**（`tests/` 或就近 `*.test.ts`），用 codex-host 的 `encodeHarnessPluginRoute` 生成的金样用例做往返。

### 4.2 model picker 并入 harness

- `model/list` 结果中 `selectedHarness` 存在 / `model` 以 `codexhost/plugin-v1@` 开头 → 归入"外部 Harness"分组
- 标签：harness 显示名（来自 `codexhost/harness/plugins/list` 的 `name`/`title`，缓存）+ 路由里的 `model`；无显示名时退回 `harnessId`
- 官方模型分组保持现状
- 选中态、`effortOptionsForModel` 逻辑不变（effort 已在 `ui/settings.ts:88`）
- 风格/交互**完全复用现有 picker 组件**（`src/ui/ActionSheet.tsx` 等），不要新造轮子

### 4.3 用量面板（点击展开）

- 入口：会话头部/工具栏一个紧凑 chip（如 `上下文 7.7%`），点击展开面板
- 展开内容按 §0 的参考文本排版：
  - 上下文 `<percent>% / <limit>`（`usage` 里的上下文字段；字段缺失则显示 `—`）
  - 缓存读取 / 缓存写入（`cachedInputTokens` / `cacheWriteInputTokens`）
  - Token 总数、输入 / 输出
  - 会话费用估算 `$0.000`
  - 若有 `planFiveHourUsedPercent` / `planSevenDayUsedPercent` 也展示
- 数字格式：`424.1k` / `7.6M`（写一个 `formatTokenCount`，单测覆盖 0/999/1000/1_500_000 边界）
- 数据来源优先级：`codexhost/thread/usage/updated` 通知实时更新 → 挂载/切线程时 `codexhost/thread/usage/inspect` 拉一次
- 所有字段 optional，缺失必须优雅降级，**不得崩溃**
- 动效与交互参照 codex-mobile 现有 sheet 的手感（`src/features/conversation/sheets/*`）

### 4.4 busy 提示

- `client.request` 收到 error 且 message 含 `busy`（或 code 对应 `OfficialAdmissionError`）→ toast "另一台设备正在使用，请稍候"
- **不**自动重试
- 参考现有 `src/ui/ErrorBanner.tsx` / toast 实现

### 4.5 删除二维码配对

删除 `src/features/backends/GatewayQrScannerSheet.tsx`、`src/features/backends/gateway-qr-scanner.ts`，清理 `BackendManagerSheet.tsx`、`src/i18n.tsx`、`src/styles.css` 中的引用与词条。后端添加改为手填 URL + token（现有 `parseBackendGatewayUrl` 已支持）。

### 4.6 构建约束（CI 会扫）

`.github/workflows/build-android.yml` 会扫描 `dist/` 与 APK assets，**以下内容一律不允许出现**：
- `localhost`、`127.*`、`10.*`、`192.168.*`、`172.16-31.*`、`169.254.*`、`::1`、`fc00::/7`、`fe80::/10` 形式的 URL
- `[?&](token|access_token|api_key|secret|password)=<8位以上>`、`bearer <12位以上>`、`CODEX_MOBILE_TOKEN=<8位以上>`
- 不在白名单里的固定 URL

→ 新增代码里**不要写死任何地址或凭据**；默认值用空串，运行时由用户输入。`tests/` 里的 fixture 若含 `127.0.0.1` 需确认不会被 `vite build` 打进 `dist/`（测试文件不参与 build，但要自查）。

## 5. Worker-ANDROID 规格

### 5.1 新 workflow `.github/workflows/build-android.yml`

基于现有文件改造（现有文件是 PakePlus 方案， pinned commit `787b9e5ea2da1b2d959485417ffeee62f0d30960`）：

**保留**：PakePlus checkout、Node/pnpm/JDK17/Android SDK/ImageMagick、icon 安装、前端 build + 资产扫描、ppconfig 配置、Manifest/Activity 加固、debug APK 校验逻辑。

**改动**：
1. **删除 `ios` job 与 `npm` job**（本仓库只出 Android APK）
2. **改为 release 签名**：
   - `assembleRelease` 而非 `assembleDebug`
   - keystore 来自 GitHub Secret，**base64 解码到 `$RUNNER_TEMP`**，绝不入库、绝不 echo
   - Secret 名：`CODEXHOST_MOBILE_KEYSTORE_BASE64`、`CODEXHOST_MOBILE_STORE_PASSWORD`、`CODEXHOST_MOBILE_KEY_ALIAS`、`CODEXHOST_MOBILE_KEY_PASSWORD`
   - 缺失任一 → 明确失败并提示"请在仓库 Settings → Secrets 配置签名密钥"
   - 用 `signingConfigs` 注入，或写 `keystore.properties` 到 `$RUNNER_TEMP` 并在 `build.gradle.kts` 读取（注意 PakePlus 的 gradle 是固定模板，改动要被现有 `grep -Fq` 断言兼容——若冲突则优先保证签名生效，并同步更新断言）
   - 构建后 `apksigner verify --print-certs` 校验签名
3. `APP_ID` 改为新包名（建议 `ai.unlgame.codexhostmobile`），`APP_NAME`/`DISPLAY_NAME` 改为 `CodexHostMobile` / `Codex Host Mobile`
4. `paths` 触发 filter 去掉 `build-ios.yml`、`publish-npm.yml`
5. Release 资产只含 APK + sha256
6. `permissions` 保持最小（`contents: read`，release job 用 `contents: write`）

### 5.2 密钥安全（用户核心关切）

- `.gitignore` 增加：`*.keystore`、`*.jks`、`keystore.properties`、`*.pepk`、`local.properties`
- 在 `docs/android-signing.md` 写清**本地生成**步骤：
  ```bash
  keytool -genkeypair -v -keystore codexhost-mobile.keystore \
    -alias codexhostmobile -keyalg RSA -keysize 4096 -validity 10000
  base64 -w0 codexhost-mobile.keystore   # 粘贴到 Secret CODEXHOST_MOBILE_KEYSTORE_BASE64
  ```
- 明确警告：keystore 与口令**永不入库、永不进日志、永不在 issue/PR 中贴出**
- workflow 里对密钥相关步骤加 `::add-mask::`（GitHub 会自动 mask secret，但显式加更稳）
- 增加一个 CI 守卫：扫描被提交文件，若出现 `*.keystore`/`keystore.properties` 或 base64 keystore 特征则失败

### 5.3 文档与元信息

- `README.md`：改为 codexhost-mobile 说明（架构图、Windows Host 前置条件、`CODEX_APP_SERVER_MODE=codexhost`、密钥配置）
- `install.md`：APK 安装 + 首次配置（手填网关地址）
- `docs/plans/2026-08-31-codexhost-mode-plan.md`：本文件归档
- `package.json`：`name` 改 `codexhost-mobile`，`description`、`bin`、`repository`、`homepage`、`bugs` 指向 `unlgame/codexhost-mobile`；`version` 保持 `0.2.0` 起
- **不要**改 `dependencies`/`devDependencies` 内容（除非确有必要）

## 6. 验收标准（Definition of Done）

1. `npm run typecheck` 通过
2. `npm test`（vitest）通过，新增测试全绿
3. `npm run build` 通过，且 `dist/` 不包含 §4.6 禁止的模式（可用 workflow 里的扫描脚本自测）
4. Windows 上：`CODEX_APP_SERVER_MODE=codexhost npm start` 能自动 spawn 小桥并连上管道
5. 两台安卓设备同时连，能看到**同一份**线程列表；桌面正在跑的外部 harness turn，手机实时收到 `item/started` / `agentMessageDelta` / `turn/completed`
6. 手机发请求、桌面同时发请求 → 后者 toast `busy`
7. model picker 能看到外部 harness 分组并可切换
8. 用量 chip 点击展开，字段齐全、降级优雅
9. workflow YAML 可解析（`python3 -c "import yaml,sys;yaml.safe_load(open(...))"`），密钥不入库

## 7. 纪律

- 不修改 `/f/worksp/claude/codex-host`
- 不改 `server/gateway.ts`（帧转发层必须保持上游原样）
- 不引入新依赖（`ws` 已在）
- 每个 worker 只碰 §2 表格里自己的路径
- 提交信息用中文 conventional commits，与现有 git log 风格一致
