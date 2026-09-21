# 签名密钥与 Release 出包说明

本文件说明 `codexhost-mobile` 的 Android APK、未签名 iOS IPA 与 npm 包如何通过 GitHub Actions
构建、发布，以及签名密钥该如何保管。**签名相关的全部材料只应存在于你的本地机器和仓库 Secrets 里。**

---

## 1. 铁律

> **keystore 与口令永不入库、永不进日志、永不在 issue 或 PR 贴出、永不提交到 fork。**

具体含义：

| 禁止事项 | 原因 |
| --- | --- |
| 把 `*.keystore` / `*.jks` / `*.pepk` 提交进仓库 | 一旦推送即视为永久泄露，历史记录里仍可被检索到 |
| 把 keystore 的 base64 字符串写进任何 `.yml`、`.json`、`.md`、脚本 | 等同于明文入库 |
| 在 workflow 里 `echo` 口令、`set -x`、把口令写进会被打印的变量 | 会进入 Actions 日志，任何有读权限的人都能看到 |
| 在 issue / PR / Discussion / 截图里贴出口令或证书指纹 | 公开可见且难以彻底删除 |
| 推到自己的 fork 时带上 keystore | fork 可能公开，也可能被他人再次 fork |
| 复用同一个 keystore 到多个项目 | 一个项目泄露会连累其他所有项目 |

`.gitignore` 已经忽略 `*.keystore`、`*.jks`、`*.pepk`、`keystore.properties`、
`local.properties`、`*.apk`、`*.aab`、`pakeplus/`。`.github/workflows/secret-guard.yml`
会在每次 push / PR 时扫描被跟踪文件，命中即失败并提示「疑似签名密钥入库，请立即移除并轮换密钥」。

---

## 2. GitHub Actions release 流程需要哪些 Secrets

仓库地址：`https://github.com/unlgame/codexhost-mobile`

`.github/workflows/build-android.yml` 会读取下面四个 Secret。**缺少任何一个都会直接失败**，

iOS 与 npm 两条流水线**不需要任何仓库 Secret**：`build-ios.yml` 产出的是未签名 IPA，
不接触 keystore；`publish-npm.yml` 通过 npm 的 trusted publishing（OIDC，
`permissions.id-token: write`）完成发布，因此既不存放 npm token，也不写任何口令。

| Secret 名称 | 取值来源 | 说明 |
| --- | --- | --- |
| `CODEXHOST_MOBILE_KEYSTORE_BASE64` | `base64 -w0 codexhost-mobile.keystore` 的完整单行输出 | keystore 文件本身的 base64 编码 |
| `CODEXHOST_MOBILE_STORE_PASSWORD` | 生成 keystore 时你设置的 store 口令 | 打开 keystore 文件所需 |
| `CODEXHOST_MOBILE_KEY_ALIAS` | 生成时 `-alias` 指定的值，例如 `codexhostmobile` | 证书条目的别名 |
| `CODEXHOST_MOBILE_KEY_PASSWORD` | 生成时设置的 key 口令（与 store 口令可以相同） | 使用私钥签名所需 |

> 命名约定：这四个名字在 workflow 的 `secrets.*` 和 Gradle 的 `System.getenv(...)` 里必须一致，
> 改动其中一侧就要同步另一侧。另外 `ANDROID_KEYSTORE_PATH` 不是 Secret，而是 CI 写到
> `$GITHUB_ENV` 的本地路径变量，指向 `$RUNNER_TEMP` 下解码出的 keystore 文件。

### 构建流程做了什么

1. 检出仓库与固定提交的 PakePlus Android 模板，安装 1024×1024 应用图标。
2. `npm ci` + `npm run build` 产出前端 `dist/`，并用内联 Node 脚本扫描 `dist/`
   （禁内网地址、禁凭据、禁白名单外 URL）。
3. `pnpm pp:worker` 生成 Android 工程，再用 Python 加固：裁剪 Manifest 权限到白名单、
   `allowBackup=false`、加 FileProvider、改写 `MainActivity.kt`、替换版本号，
   **并注入 release `signingConfig`**。
4. 签名配置只写「环境变量名」，不写任何口令：

   ```kotlin
   signingConfigs {
       create("codexhost") {
           storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "")
           storePassword = System.getenv("CODEXHOST_MOBILE_STORE_PASSWORD")
           keyAlias = System.getenv("CODEXHOST_MOBILE_KEY_ALIAS")
           keyPassword = System.getenv("CODEXHOST_MOBILE_KEY_PASSWORD")
       }
   }
   ```

5. keystore 只解码到 `$RUNNER_TEMP`（runner 临时目录），**不落到 workspace**，
   因此不会被 `upload-artifact` 或 Gradle 缓存带出。
6. `./gradlew assembleRelease` 后用 `apksigner verify --print-certs` 校验签名，
   断言证书主题包含预期 alias、且不是 debug 签名。
7. 通过后上传 artifact 并创建 GitHub Release。

iOS 与 npm 两条流水线由同一个 `release` job 串联：

- `build-ios.yml` 在 macOS runner 上构建**未签名** IPA（`CODE_SIGNING_ALLOWED=NO`），
  产物为 `CodexHostMobile-v<version>-unsigned.ipa` 与对应 `.sha256`；
- `publish-npm.yml` 跑 `npm ci`、`npm test`、`npm run build:package`、
  `npm pack --dry-run`，确认无误后 `npm publish --access public`；
  发布前会先把 `package.json` 的版本对齐到本次 Release 的版本号，避免版本漂移。
---

## 3. 本地生成密钥（仅本地生成，不要在任何在线工具里生成）

```bash
keytool -genkeypair -v -keystore codexhost-mobile.keystore \
  -alias codexhostmobile -keyalg RSA -keysize 4096 -validity 10000
```

交互式提示里的「名字与姓氏 / 组织 / 城市」等只是证书主题，可填占位值；
**两个口令请自己另外生成，不要使用示例值**。

生成后查看条目确认 alias：

```bash
keytool -list -v -keystore codexhost-mobile.keystore
```

得到 keystore 的单行 base64（用于 `CODEXHOST_MOBILE_KEYSTORE_BASE64`）：

```bash
base64 -w0 codexhost-mobile.keystore
```

把这三段输出分别粘到仓库 Secrets 里。**粘完立刻关掉终端历史里的敏感内容**，
并且不要把 base64 字符串保存到任何会被同步或备份的地方。

---

## 4. 本地验证 APK 签名

```bash
apksigner verify --print-certs CodexHostMobile-v<version>.apk
```

应看到 `Signer #1 certificate DN:` 且 DN 中包含你的 alias。也可以用 JDK 自带工具：

```bash
keytool -printcert -jarfile CodexHostMobile-v<version>.apk
```

---

## 5. 产物名与下载方式

产物名固定为：

```
CodexHostMobile-v<version>.apk
CodexHostMobile-v<version>.apk.sha256
CodexHostMobile-v<version>-unsigned.ipa
CodexHostMobile-v<version>-unsigned.ipa.sha256
```

npm 包与 Release 同版本号，包名为 `codexhost-mobile`。

下载途径：

1. **Actions Artifacts**：进入 Actions → 对应 workflow run → Artifacts → `CodexHostMobile-android`
   （APK）或 `CodexHostMobile-ios-unsigned`（IPA）。artifact 保留 7 天。
2. **GitHub Release**：push 到 `main` 且构建通过后，release job 会创建
   `v<version>` 标签的 Release，直接附带 APK、IPA 与各自的 `.sha256`。
3. **npm**：`npm view codexhost-mobile version` 应与 Release 版本一致。

下载后建议校验：

```bash
sha256sum --check CodexHostMobile-v<version>.apk.sha256
sha256sum --check CodexHostMobile-v<version>-unsigned.ipa.sha256
```

---

## 6. 如何在新仓库配置 Secrets

1. 打开 `https://github.com/unlgame/codexhost-mobile`。
2. **Settings → Secrets and variables → Actions → New repository secret**。
3. 依次添加第 2 节表格中的四个 Secret，名称必须完全一致（区分大小写）。
4. 添加后无需重启，下一次 push 到 `main` 或手动 `workflow_dispatch` 即可生效。
5. **不要**把这些 Secret 配到 fork 上；fork 请用自己的 keystore，见
   [`FORK.md`](./FORK.md)。

---

## 7. 密钥泄漏后的处置

一旦怀疑 keystore 或任一口令泄漏（误提交、误贴、日志泄露、设备丢失、 fork 带出等）：

1. **立即轮换**：在本地重新 `keytool -genkeypair` 生成一套全新的 keystore 与口令。
2. 更新仓库 Secrets 的四个值。
3. 重新发布一个版本号更高的 Release。
4. 已分发出去的旧 APK **无法被吊销签名**，只能靠升级覆盖；请在 Release notes 里明确告知用户必须升级。
5. 如果泄漏发生在 git 历史里，仅删除文件不够，需要改写历史或直接废弃该仓库。
6. 检查 Actions 日志与 fork 列表，确认没有二次扩散。

---

## 8. 本地出包命令（可选）

正常情况下不需要本地出包，CI 已经覆盖。如果你确实需要本地验证：

```bash
# 1. 生成 keystore（占位示例，实际值自行替换）
keytool -genkeypair -v -keystore codexhost-mobile.keystore \
  -alias <your-alias> -keyalg RSA -keysize 4096 -validity 10000

# 2. 前端构建
npm ci
npm run build

# 3. 按 .github/workflows/build-android.yml 的步骤准备 PakePlus 工程并
#    ./gradlew assembleRelease，同时导出：
export ANDROID_KEYSTORE_PATH="$PWD/codexhost-mobile.keystore"
export CODEXHOST_MOBILE_STORE_PASSWORD='<your-store-password>'
export CODEXHOST_MOBILE_KEY_ALIAS='<your-alias>'
export CODEXHOST_MOBILE_KEY_PASSWORD='<your-key-password>'

# 4. 校验签名
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

**本地出包时同样不要把上述 export 写进任何会被提交的文件。**
