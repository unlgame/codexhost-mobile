# iOS 加固脚本回归 fixture

`tests/ci/ios-hardening.test.ts` 会把这里摊成 `<workdir>/PakePlus/...`，
然后拿 `.github/workflows/build-ios.yml` 里那段内联 Python 实跑一遍。

## 为什么单独放一份

那段 Python 是全仓库最容易静默坏掉的地方：它是一大坨嵌在 YAML 里的字符串字面量，
任何一处 `
` 转义写错，结果都是「锚点在钉住的 PakePlus 里找不到 → SystemExit → 发布失败」，
而本地 `npm test` 完全碰不到它。

所以这里的每个片段都从 **PakePlus-iOS 钉住提交** 里逐字抽取，而不是从 workflow 的 Python 里抄的
——两者必须相互独立，否则 workflow 的转义写错时，测试会跟着一起错，什么也发现不了。

## 提升 `PAKEPLUS_IOS_REF` 时

从 `<ref>:PakePlus/WebView.swift` 逐字抽取以下 6 个片段后替换 `WebView.swift`：

| 变量 | 内容 |
| --- | --- |
| `developer_extras` | 8 空格缩进的整个 `enable developer extras` 块 |
| `media_prompt` | `decisionHandler(permissionDecisionForMediaCapture(type: type))` |
| `bridge_registration` | `userContentController.add(context.coordinator, name: "blobDownload")` |
| `coordinator_fields` | `private var locationManager: CLLocationManager?` |
| `message_handler` | `didReceive` 函数签名 + `guard message.name == "blobDownload"` |
| `geolocation_prompt` | `context.coordinator.prepareWebGeolocationAuthorization()` |

文件必须保持 LF：`.gitattributes` 锁死了 `eol=lf`，测试里也有断言。
