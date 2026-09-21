# Secrets 配置说明

`codexhost-mobile` 的 Android 出包完全依赖 GitHub Actions + 仓库 Secrets。
本文件说明每个 Secret 的用途、如何在 fork 上自己配置、以及如何轮换。

仓库：`https://github.com/unlgame/codexhost-mobile`

---

## 1. 四个 Secrets 一览

| Secret 名称 | 用途 | 取不到时的后果 |
| --- | --- | --- |
| `CODEXHOST_MOBILE_KEYSTORE_BASE64` | `base64 -w0 codexhost-mobile.keystore` 的单行输出，CI 用它还原 keystore 文件到 `$RUNNER_TEMP` | 构建在「Decode release signing keystore」步骤直接失败 |
| `CODEXHOST_MOBILE_STORE_PASSWORD` | 打开 keystore 文件（store 口令） | 同上；`keytool -list` 校验失败 |
| `CODEXHOST_MOBILE_KEY_ALIAS` | 证书条目别名，CI 用它断言 APK 证书主题 | 签名后校验证书主题的步骤失败 |
| `CODEXHOST_MOBILE_KEY_PASSWORD` | 使用私钥签名（key 口令） | `assembleRelease` 失败 |

四个都是**必填**，缺任何一个都不会退化成 debug 签名，而是明确报错。
这是有意的：宁可构建失败，也不要产出签名不明确的包。
这四个只服务 Android。`build-ios.yml` 产出的是未签名 IPA，`publish-npm.yml` 走 npm
trusted publishing（OIDC），两条流水线都不读取任何仓库 Secret，因此没有 npm token
之类的第五个 Secret。

> 命名约定：workflow 通过 `secrets.CODEXHOST_MOBILE_*` 读取上表四个值，再以同名环境变量
> 注入 Gradle 的 `System.getenv(...)`。两边名字必须一致，改一处就得同步另一处，
> 否则会出现「Secret 已配但取不到值」的失败。
>
> 另外，`ANDROID_KEYSTORE_PATH` 不是 Secret，而是 CI 自己写到 `$GITHUB_ENV` 的
> 本地路径变量，指向 `$RUNNER_TEMP` 下解码出来的 keystore 文件。

---

## 2. 生成自己的 keystore

**只在本地生成**，不要使用任何在线 keystore 生成服务，也不要把生成过程放到 CI 里。

```bash
keytool -genkeypair -v -keystore codexhost-mobile.keystore \
  -alias codexhostmobile -keyalg RSA -keysize 4096 -validity 10000
```

- `-alias` 的值就是你要填进 `CODEXHOST_MOBILE_KEY_ALIAS` 的内容。
- store 口令与 key 口令可以设成相同，也可以不同；不同更安全，但要分别记住。
- `-validity 10000` 约 27 年，足够覆盖应用生命周期。

拿到 base64：

```bash
base64 -w0 codexhost-mobile.keystore
```

确认 alias 存在：

```bash
keytool -list -v -keystore codexhost-mobile.keystore
```

---

## 3. 在仓库 / fork 上配置

1. 打开仓库页面（fork 就打开你自己的 fork）。
2. **Settings → Secrets and variables → Actions**。
3. 点 **New repository secret**，逐个添加第 1 节的四个 Secret。
   - 名称区分大小写，必须完全一致。
   - 值不要带引号、不要带首尾空格、不要带换行（base64 必须是单行）。
4. 保存后立即生效，下一次 push 到 `main` 或手动触发 `workflow_dispatch` 即可。

**不要把 Secret 配成 Environment secret 以外的形式**，也不要在 PR 里让 fork 的 workflow
读到上游仓库的 Secret——GitHub 默认就不会把 Secret 传给 fork 来的 PR。

---

## 4. 轮换步骤

出现以下任一情况就需要轮换：

- keystore 文件或口令被误提交、误贴、误截图
- Actions 日志里出现了口令或 base64 串
- 存放 keystore 的设备丢失或不再受信任
- fork 时不小心带出了 keystore
- 团队成员变动且其曾接触过 Secret

轮换流程：

1. 本地重新生成一套全新的 keystore 与口令（换新文件名，避免混淆）。
2. 用新 alias 更新 `CODEXHOST_MOBILE_KEY_ALIAS`。
3. 用新的 base64 更新 `CODEXHOST_MOBILE_KEYSTORE_BASE64`。
4. 更新 `CODEXHOST_MOBILE_STORE_PASSWORD` / `CODEXHOST_MOBILE_KEY_PASSWORD`。
5. 触发一次构建，确认 `apksigner verify --print-certs` 输出的证书主题是新 alias。
6. 发一个新版本 Release，并在 notes 里要求用户升级。
7. 旧 keystore 与旧口令**物理删除**（含回收站、备份、同步盘）。
8. 如果泄漏进入过 git 历史，删除文件不够，需要改写历史或废弃仓库。

> 注意：Android 签名无法「吊销」。已安装旧 APK 的用户只有在升级到同包名、
> 同签名的新版本时才能平滑覆盖；如果签名彻底更换，用户必须先卸载旧应用。

---

## 5. 安全检查清单

推送前自查：

- [ ] `git status` 没有 `*.keystore` / `*.jks` / `*.pepk` / `keystore.properties` / `local.properties`
- [ ] `git log -p` 里搜不到 base64 形态的长串
- [ ] workflow 里没有 `echo "$CODEXHOST_MOBILE_STORE_PASSWORD"`、没有 `set -x`
- [ ] Actions 日志里没有出现口令
- [ ] fork 前确认 `.gitignore` 已覆盖上述文件
- [ ] keystore 只保存在本地一个受信任位置，并有离线备份

`.github/workflows/secret-guard.yml` 会在每次 push / PR 自动执行前四项中的大部分检查。

---

## 6. 相关文档

- [`RELEASE.md`](./RELEASE.md)：签名与出包全流程
- [`FORK.md`](./FORK.md)：fork 后如何构建自己的 APK
- [`../install.md`](../install.md)：终端用户安装 APK 的说明
