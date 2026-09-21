# 更新日志

本项目从 `loock-ai/codex-mobile` 演化为 `unlgame/codexhost-mobile`，
定位从「手机扫码连网关」改为「把手机作为外部 harness 终端连到 Windows codex-host」。
本文件记录 Android 化与品牌改名相关的改动，便于追溯。

---


## [0.2.1] — Windows 适配收尾

### 本地开发

- `npm run dev` 改为由 `bin/dev.mjs` 驱动，替换原先的 `zsh -lc 'source …'` 一行式脚本。
  `zsh` 与 `VAR=value cmd` 前缀都是 POSIX 专属语法，Windows 上整条命令原本无法执行。
- 网关环境文件位置统一为 `CodexHostWeb/gateway.env`：Windows 取 `%APPDATA%`，
  macOS 取 `~/Library/Application Support`，其余取 `$XDG_CONFIG_HOME`；
  macOS 继续兼容历史目录 `CodexMobileWeb`。`CODEX_MOBILE_ENV_FILE` 仍可显式覆盖。
- `dev:gateway` / `dev:web` / `start` 改用 `cross-env` 设置环境变量，去掉 shell 前缀语法。
- 启动器直接以 `node` 调用 concurrently 的 JS 入口，避免 Windows 上经 shell 启动 `.cmd`
  触发 DEP0190 告警，同时保证 SIGINT 能原样传给 concurrently。
- 新增 `CODEX_MOBILE_DEV_DRY_RUN=1` 干跑模式，只报告环境文件解析结果与 concurrently 参数。
- 新增 [`local-development.md`](./local-development.md) 记录本地开发流程。

### 应用标识与更新

- iOS bundle id 由 `vip.loock.codexmobile` 改为 `ai.unlgame.codexhostmobile`，与 Android
  applicationId 统一。
- 应用内自动更新的仓库地址、API 地址、缓存键与 APK 资产名改指本 fork 与
  `CodexHostMobile-v<version>.apk`，此前指向已废弃的上游仓库，自动更新完全失效。

## [0.2.0] — codexhost-mobile / Android 化

### 品牌与元信息

- 项目更名为 **codexhost-mobile**，显示名 **Codex Host Mobile**。
- 应用包名（applicationId）由 `vip.loock.codexmobile` 改为 `ai.unlgame.codexhostmobile`。
- 仓库地址统一指向 `https://github.com/unlgame/codexhost-mobile`。
- `package.json` 的 `name` / `description` / `bin` / `repository` / `homepage` / `bugs` /
  `keywords` 全部更新；`version` 保持 `0.2.0`；依赖未做任何变更。
- 应用内更新地址与 APK 文件名正则改为只接受本仓库 Release 的资源。

### 构建与发布

- **恢复 iOS 构建**：`build-ios.yml` 重新接入主 workflow 的 `ios` job（`uses:` 调用），
  在 macOS runner 上产出**未签名** IPA（`CODE_SIGNING_ALLOWED=NO`），产物为
  `CodexHostMobile-v<version>-unsigned.ipa` 与对应 `.sha256`，并重新进入 Release 资产。
  iOS 的 bundle id 与 Android applicationId 统一为 `ai.unlgame.codexhostmobile`。
- **恢复 npm 发布**：`publish-npm.yml` 重新接入主 workflow 的 `npm` job，
  通过 `publish_npm` 输入（默认关闭）控制；发布前把 `package.json` 版本对齐到本次
  Release 版本号，再跑 `npm test` / `npm run build:package` / `npm pack --dry-run`，
  最后 `npm publish --access public`。发布走 npm trusted publishing（OIDC，
  `permissions.id-token: write`），**不引入 npm token Secret**。
- **Release 资产重新包含 iOS 与 npm**：APK、IPA 与同版本 npm 包共用一个解析后的版本号。
- **移除多余的 `release.yml`**：Release 创建统一收敛到主 workflow 的 `release` job。
- **Android 改为 release 签名**：
  - `assembleDebug` → `assembleRelease`。
  - keystore 只从 GitHub Secrets 读取，解码到 `$RUNNER_TEMP`，不落入 workspace，
    因此不会被 `upload-artifact` 或构建缓存带出。
  - 口令显式 `::add-mask::`；全流程不 `echo` 密钥内容、不使用 `set -x`。
  - 通过 Python 加固脚本向 PakePlus 生成的 `app/build.gradle.kts` 注入
    `signingConfigs`，并配套「精确命中一次」的断言，防止注入点漂移。
  - 构建后用 `apksigner verify --print-certs` 校验签名，并断言证书主题包含预期
    alias、且不是 debug 证书；不硬编码证书指纹。
  - 产物统一为 `CodexHostMobile-v<version>.apk` 与对应 `.sha256`。

### 密钥安全

- 新增 `.github/workflows/secret-guard.yml`：每次 push / PR 扫描被跟踪文件，
  命中 keystore 文件名、keystore 魔数、`keytool -genkeypair` 调用痕迹、
  `storePassword` / `keyPassword` / `keyAlias` 赋值即失败。
- 修复 secret-guard 最初把文件列表用管道喂给 heredoc 的 `python3 -` 导致 stdin 被
  heredoc 抢占、守卫静默通过的问题；改为先落盘再用 `argv` 传入，并保留
  「未扫到任何文件即失败」的兜底。
- `.gitignore` 增加 `*.keystore`、`*.jks`、`*.pepk`、`keystore.properties`、
  `local.properties`、`*.apk`、`*.aab`、`pakeplus/`。

### 应用行为

- `AppUpdater.kt` 的 `allowedPrefix` 收敛到本仓库 Release 下载前缀；
  APK 文件名正则同步收紧。
- Manifest 权限裁剪到白名单，`allowBackup=false`，新增 FileProvider，
  edge-to-edge + CSS 安全区变量，JsInterface 提供版本查询与 APK 安装能力。
- `CODEX_APP_SERVER_MODE=codexhost` 模式下经 Windows 网关访问 codex-host 小桥，
  再走命名管道连到 AppServerHost。

### 文档

- 新增 `docs/RELEASE.md`：签名密钥、CI 出包流程、产物下载、泄漏处置。
- 新增 `docs/SECRETS.md`：四个 Secret 的用途、fork 配置、轮换步骤。
- 新增 `docs/FORK.md`：fork 后构建自己的 APK。
- 新增 `docs/android-signing.md`：本地生成 keystore 与本地校验签名。
- `README.md` / `install.md` 重写为 codexhost-mobile 品牌，安装改为手填网关地址。
- 补回 iOS / npm 发布说明：`README.md` 新增「移动端构建」章节、iOS 徽章与
  `Web | Android | iOS` 平台栏；`install.md` 增加 IPA 下载校验与 npm 网关安装两节；
  `docs/RELEASE.md`、`docs/SECRETS.md`、`docs/FORK.md` 同步说明 iOS 与 npm 两条流水线。

---

## 与上游的关系

本仓库是 `loock-ai/codex-mobile` 的下游分支。上游提供 Web 客户端与网关的通用能力；
本仓库在此之上做了 Android 化、签名出包与密钥安全改造，并把产品定位调整为
codexhost 模式的外部 harness 终端。上游仍在维护的通用 Web 功能未被删除，
只是本仓库的构建产物与分发渠道已切换为 GitHub Releases 上的签名 APK、未签名 iOS IPA，
以及 npm 上的 `codexhost-mobile` 包。
