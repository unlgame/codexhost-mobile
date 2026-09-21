# Fork 后构建自己的 APK

本文件面向想自己出包的人：从 `unlgame/codexhost-mobile` fork 一份，配好自己的签名密钥，
然后让 GitHub Actions 产出属于你自己的 APK、未签名 iOS IPA，以及你自己的 npm 包。

---

## 0. 先说清楚

- **不要**使用上游仓库的 keystore，也不要在任何地方向上游 PR 提交 keystore。
- 你自己 fork 的 workflow 读的是**你自己 fork 的 Secrets**，与上游完全隔离。
- 包名固定为 `ai.unlgame.codexhostmobile`。改了包名就等于换了一个应用，
  用户无法覆盖升级，需要先卸载旧版。
- fork 之后 iOS 与 npm 两条流水线同样可用：iOS 产出未签名 IPA，npm 走 trusted
  publishing（OIDC），需要在 npm 上为你的包单独配置发布者，不需要任何 Secret。

---

## 1. Fork

1. 打开 `https://github.com/unlgame/codexhost-mobile`。
2. 点右上角 **Fork**，fork 到你的账号下。
3. 克隆到本地：

   ```bash
   git clone https://github.com/<your-account>/codexhost-mobile.git
   cd codexhost-mobile
   ```

4. 确认 `.gitignore` 已覆盖密钥文件（默认已覆盖）：

   ```bash
   git check-ignore -v codexhost-mobile.keystore keystore.properties local.properties
   ```

   三条都应输出对应的 ignore 规则。如果没有，说明 `.gitignore` 被改坏了，先修好再继续。

---

## 2. 本地生成 keystore

```bash
keytool -genkeypair -v -keystore codexhost-mobile.keystore \
  -alias codexhostmobile -keyalg RSA -keysize 4096 -validity 10000
```

记录三样东西（**只记在本地**）：

| 内容 | 对应 Secret |
| --- | --- |
| `base64 -w0 codexhost-mobile.keystore` 的输出 | `CODEXHOST_MOBILE_KEYSTORE_BASE64` |
| 你设的 store 口令 | `CODEXHOST_MOBILE_STORE_PASSWORD` |
| `-alias` 的值 | `CODEXHOST_MOBILE_KEY_ALIAS` |
| 你设的 key 口令 | `CODEXHOST_MOBILE_KEY_PASSWORD` |

```bash
base64 -w0 codexhost-mobile.keystore
keytool -list -v -keystore codexhost-mobile.keystore
```

---

## 3. 在自己的 fork 上配 Secrets

1. 打开你 fork 的仓库页面。
2. **Settings → Secrets and variables → Actions → New repository secret**。
3. 依次添加 `CODEXHOST_MOBILE_KEYSTORE_BASE64`、`CODEXHOST_MOBILE_STORE_PASSWORD`、
   `CODEXHOST_MOBILE_KEY_ALIAS`、`CODEXHOST_MOBILE_KEY_PASSWORD`。
4. 名称必须与 workflow 完全一致（区分大小写），base64 必须是单行、无首尾空格。

配好前不要急着 push——workflow 会在解码步骤明确失败并提示缺哪个 Secret。

---

## 4. 触发构建

两种方式：

**A. 自动**：push 到 `main` 分支（且改动命中 `paths` 过滤）会自动触发。

**B. 手动**：Actions → *Build CodexHostMobile Android APK* → **Run workflow**，
可选填 `release_version` 覆盖版本号；勾选 `publish_npm` 可让本次发布同时把 npm 包发出去。

构建成功后：

- Artifacts 页下载 `CodexHostMobile-android`，里面是
  `CodexHostMobile-v<version>.apk` 和 `.sha256`（保留 7 天）；iOS 产物在
  `CodexHostMobile-ios-unsigned`，里面是未签名 IPA 和 `.sha256`。
- 如果构建是由 `main` 分支的 push 触发，release job 还会创建一个 draft→published 的
  GitHub Release，直接附带 APK、IPA；同时 `publish-npm.yml` 会把同版本的
  `codexhost-mobile` 包发到 npm。

---

## 5. 本地校验签名

```bash
apksigner verify --print-certs CodexHostMobile-v<version>.apk
```

`Signer #1 certificate DN:` 里应包含你自己的 alias。CI 里也有同样的断言，
不一致会直接让构建失败。

---

## 6. 常见问题

| 现象 | 原因 |
| --- | --- |
| 「缺少 Android release 签名 Secret」 | 四个 Secret 有缺失或名称为空 |
| 「不是有效的 Java keystore」 | base64 被折断成多行，或粘的时候带了空格/换行 |
| 「无法用 CODEXHOST_MOBILE_STORE_PASSWORD 打开 keystore」 | store 口令填错，注意大小写 |
| 「keystore 中不存在别名 …」 | `CODEXHOST_MOBILE_KEY_ALIAS` 与 `-alias` 不一致 |
| 「签名证书主题不包含预期 alias」 | alias  Secret 与 keystore 实际内容不匹配 |
| secret-guard 报「疑似签名密钥入库」 | 有密钥文件被跟踪了，`git rm --cached` 后重新提交，并轮换密钥 |

---

## 7. 相关文档

- [`RELEASE.md`](./RELEASE.md)：签名与出包全流程
- [`SECRETS.md`](./SECRETS.md)：Secrets 用途与轮换
- [`../install.md`](../install.md)：终端用户安装 APK 的说明
