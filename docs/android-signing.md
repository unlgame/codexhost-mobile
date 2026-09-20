# Android 签名说明

本文件说明 `codexhost-mobile` 的 APK 签名密钥如何**在本地生成**、如何验证签名，
以及为什么密钥永不入库。

> **铁律：keystore 与口令永不入库、永不进日志、永不在 issue 或 PR 贴出、永不提交到 fork。**

---

## 1. 本地生成密钥

密钥**只在本地生成**。不要使用任何在线 keystore 生成服务，也不要把生成步骤放进 CI。

```bash
keytool -genkeypair -v -keystore codexhost-mobile.keystore \
  -alias codexhostmobile -keyalg RSA -keysize 4096 -validity 10000
```

参数含义：

| 参数 | 说明 |
| --- | --- |
| `-keystore codexhost-mobile.keystore` | 生成的 keystore 文件名，保持本地即可 |
| `-alias codexhostmobile` | 证书条目别名，之后要填进 `ANDROID_KEY_ALIAS` |
| `-keyalg RSA -keysize 4096` | 算法与密钥长度 |
| `-validity 10000` | 有效期天数（约 27 年） |

交互式会询问 store 口令与 key 口令。这两个口令**不要使用示例值**，自行另行生成；
可以设成相同，也可以不同（不同更安全，但需分别牢记）。

生成后确认 alias 存在：

```bash
keytool -list -v -keystore codexhost-mobile.keystore
```

---

## 2. 取得四个 Secret 的取值

| Secret 名称 | 取值来源 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 codexhost-mobile.keystore` 的单行输出 |
| `ANDROID_KEYSTORE_PASSWORD` | 生成时设置的 store 口令 |
| `ANDROID_KEY_ALIAS` | 生成时 `-alias` 指定的值 |
| `ANDROID_KEY_PASSWORD` | 生成时设置的 key 口令 |

```bash
base64 -w0 codexhost-mobile.keystore
```

`base64 -w0` 必须输出**单行**。如果粘到 Secret 里带了换行或空格，CI 会报
「不是有效的 Java keystore」。

---

## 3. 配置到仓库 Secrets

在 `https://github.com/unlgame/codexhost-mobile`：

**Settings → Secrets and variables → Actions → New repository secret**

逐个添加上面四个 Secret，名称区分大小写，必须完全一致。保存后下一次 push 到 `main`
或手动触发 `workflow_dispatch` 即生效。

---

## 4. 本地验证签名

```bash
apksigner verify --print-certs CodexHostMobile-v<version>.apk
```

预期输出类似：

```
Signer #1 certificate DN: CN=codexhostmobile, ...
```

`Signer #1 certificate DN:` 中应包含你的 alias。CI 里有同样的断言，不一致会直接失败。

也可以用 JDK 自带工具：

```bash
keytool -printcert -jarfile CodexHostMobile-v<version>.apk
```

校验完整性：

```bash
sha256sum --check CodexHostMobile-v<version>.apk.sha256
```

---

## 5. 安全要求

- keystore 与口令**永不入库**：`.gitignore` 已忽略 `*.keystore`、`*.jks`、`*.pepk`、
  `keystore.properties`、`local.properties`。
- **永不进日志**：CI 只把 keystore 解码到 `$RUNNER_TEMP`，口令显式 `::add-mask::`，
  且全流程不 `echo` 密钥、不使用 `set -x`。
- **永不在 issue / PR 贴出**：包括截图、复现步骤、日志片段。
- **永不提交到 fork**：fork 前确认 `.gitignore` 覆盖上述文件。
- 一旦泄漏：立即重新 `keytool -genkeypair` 生成新密钥、更新四个 Secret、
  发新版本 Release，并告知用户必须升级。Android 签名**无法吊销**。

`.github/workflows/secret-guard.yml` 会在每次 push / PR 自动检查是否误提交。

---

## 6. 相关文档

- [`RELEASE.md`](./RELEASE.md)：签名与出包全流程
- [`SECRETS.md`](./SECRETS.md)：Secrets 用途与轮换
- [`FORK.md`](./FORK.md)：fork 后构建自己的 APK
