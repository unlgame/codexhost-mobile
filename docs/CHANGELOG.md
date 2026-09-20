# 更新日志

本项目从 `loock-ai/codex-mobile` 演化为 `unlgame/codexhost-mobile`，
定位从「手机扫码连网关」改为「把手机作为外部 harness 终端连到 Windows codex-host」。
本文件记录 Android 化与品牌改名相关的改动，便于追溯。

---

## [0.2.0] — codexhost-mobile / Android 化

### 品牌与元信息

- 项目更名为 **codexhost-mobile**，显示名 **Codex Host Mobile**。
- 应用包名（applicationId）由 `vip.loock.codexmobile` 改为 `ai.unlgame.codexhostmobile`。
- 仓库地址统一指向 `https://github.com/unlgame/codexhost-mobile`。
- `package.json` 的 `name` / `description` / `bin` / `repository` / `homepage` / `bugs` /
  `keywords` 全部更新；`version` 保持 `0.2.0`；依赖未做任何变更。
- 应用内更新地址与 APK 文件名正则改为只接受本仓库 Release 的资源。

### 构建与发布

- **移除 iOS 构建**：删除 `build-ios.yml`，主 workflow 中 `build_ios` 相关逻辑、
  版本计算里的 iOS 输入、以及 Release 资产中的 iOS 产物全部移除。
- **移除 npm 发布**：删除 `publish-npm.yml`，`publish_npm` 逻辑与 npm 相关输入、
  Release 资产一并移除。
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
- **Release 资产收敛**：只保留 APK 与 `.sha256`。

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

---

## 与上游的关系

本仓库是 `loock-ai/codex-mobile` 的下游分支。上游提供 Web 客户端与网关的通用能力；
本仓库在此之上做了 Android 化、签名出包与密钥安全改造，并把产品定位调整为
codexhost 模式的外部 harness 终端。上游仍在维护的通用 Web 功能未被删除，
只是本仓库的构建产物与分发渠道已切换为 GitHub Releases 上的签名 APK。
