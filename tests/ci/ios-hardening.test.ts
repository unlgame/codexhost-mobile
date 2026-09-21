import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * iOS 工作流里那段 `python3 - <<'PY'` 加固脚本是全仓库最容易静默坏掉的地方：
 * 它是一大坨嵌在 YAML 里的 Python 字符串字面量，任何一处 `\n` 转义写错，
 * 结果都是「锚点在钉住的 PakePlus 里找不到 → SystemExit → 发布失败」，
 * 而本地跑 `npm test` 完全碰不到它。
 *
 * 这里把 heredoc 抽出来，对着 tests/ci/fixtures/pakeplus-ios-host 实跑一遍。
 * fixture 的每个片段都是从 PakePlus-iOS 钉住提交里逐字抽取的，与 workflow 相互独立，
 * 所以 workflow 的转义一旦写错，这里就会红。
 */

const WORKFLOW = ".github/workflows/build-ios.yml";
const FIXTURE = "tests/ci/fixtures/pakeplus-ios-host";

/** 脚本在钉住文件里查找的 6 个锚点，fixture 必须原样保留它们。 */
const ANCHORS = {
  developerExtras: "        // enable developer extras\n",
  mediaPrompt: "        decisionHandler(permissionDecisionForMediaCapture(type: type))",
  bridgeRegistration:
    '        webView.configuration.userContentController.add(' +
    'context.coordinator, name: "blobDownload")',
  coordinatorFields: "    private var locationManager: CLLocationManager?\n",
  messageHandler:
    "    func userContentController(_ userContentController: " +
    "WKUserContentController, didReceive message: WKScriptMessage) {\n" +
    '        guard message.name == "blobDownload" else { return }',
  geolocationPrompt:
    "        context.coordinator.prepareWebGeolocationAuthorization()\n",
} as const;

interface IosWorkflow {
  jobs?: {
    build?: {
      steps?: Array<{ run?: string }>;
    };
  };
}

function resolvePython(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      // 试下一个
    }
  }
  return null;
}

const python = resolvePython();

function extractPythonSource(): string {
  const source = readFileSync(WORKFLOW, "utf8");
  const workflow = parse(source) as IosWorkflow;
  const steps = workflow.jobs?.build?.steps ?? [];
  const run = steps.find((step) =>
    step.run?.includes("python3 - <<'PY'"),
  )?.run;
  expect(run, "build-ios.yml 应包含 python3 - <<'PY' 加固步骤").toBeTruthy();

  const marker = "python3 - <<'PY'";
  const body = (run as string)
    .slice((run as string).indexOf(marker) + marker.length)
    .replace(/^\n/, "");
  const end = body.search(/\nPY(\n|$)/);
  expect(end, "PY heredoc 缺少结束定界符，脚本体可能被截断").toBeGreaterThan(0);
  return body.slice(0, end);
}

/** 把 fixture 摊成脚本期望的 `<workdir>/PakePlus/...` 布局。 */
function stageWorkdir(): string {
  const workdir = mkdtempSync(join(tmpdir(), "codexhost-ios-"));
  mkdirSync(join(workdir, "PakePlus", "assets"), { recursive: true });
  cpSync(join(FIXTURE, "WebView.swift"), join(workdir, "PakePlus", "WebView.swift"));
  cpSync(join(FIXTURE, "index.html"), join(workdir, "PakePlus", "index.html"));
  cpSync(
    join(FIXTURE, "assets", "index-abc123.js"),
    join(workdir, "PakePlus", "assets", "index-abc123.js"),
  );
  cpSync(join(FIXTURE, "vConsole.js"), join(workdir, "PakePlus", "vConsole.js"));
  return workdir;
}

let workdir: string | null = null;

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("iOS 加固脚本（build-ios.yml 内联 Python）", () => {
  it("把 PakePlus-iOS 钉在固定提交上，升级要显式改", () => {
    const source = readFileSync(WORKFLOW, "utf8");
    const workflow = parse(source) as {
      jobs?: {
        build?: {
          steps?: Array<{
            uses?: string;
            with?: { repository?: string; ref?: string };
          }>;
        };
      };
    };
    const checkout = workflow.jobs?.build?.steps?.find((step) =>
      step.with?.repository?.includes("PakePlus-iOS"),
    );
    expect(checkout?.with?.repository).toBe("Sjj1024/PakePlus-iOS");
    expect(checkout?.with?.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fixture 仍保留脚本要查找的全部锚点", () => {
    const swift = readFileSync(join(FIXTURE, "WebView.swift"), "utf8");
    for (const [name, anchor] of Object.entries(ANCHORS)) {
      expect(swift, `fixture 缺少锚点 ${name}`).toContain(anchor);
    }
    // CRLF 会让所有按 LF 断言的锚点静默失配；.gitattributes 锁死 eol=lf。
    expect(swift, "fixture 必须是 LF").not.toContain("\r");
    expect(existsSync(join(FIXTURE, "vConsole.js"))).toBe(true);
    expect(readFileSync(join(FIXTURE, "index.html"), "utf8")).toContain(
      "./assets/",
    );
  });

  it.runIf(python !== null)("Python 源码可以编译", () => {
    const script = extractPythonSource();
    const file = join(
      mkdtempSync(join(tmpdir(), "codexhost-py-")),
      "harden.py",
    );
    writeFileSync(file, script, "utf8");
    expect(() =>
      execFileSync(python as string, ["-m", "py_compile", file], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it.runIf(python !== null)("对 fixture 实跑后产出全部实时音频改动", () => {
    const script = extractPythonSource();
    workdir = stageWorkdir();
    const file = join(workdir, "harden.py");
    writeFileSync(file, script, "utf8");

    // cwd 必须是含 PakePlus/ 的目录：脚本里用的是相对路径。
    expect(() =>
      execFileSync(python as string, [file], {
        cwd: workdir as string,
        stdio: "pipe",
      }),
    ).not.toThrow();

    const swift = readFileSync(join(workdir as string, "PakePlus", "WebView.swift"), "utf8");

    // 1) 注册 realtimeAudio 消息通道（逐字节断言，直接盯住 \n 转义）
    expect(swift).toContain(
      '        webView.configuration.userContentController.add(context.coordinator, name: "blobDownload")\n' +
        '        webView.configuration.userContentController.add(context.coordinator, name: "realtimeAudio")\n' +
        "        context.coordinator.realtimeWebView = webView",
    );

    // 2) Coordinator 增加实时音频所需字段
    expect(swift).toContain(
      "    private var locationManager: CLLocationManager?\n" +
        "    weak var realtimeWebView: WKWebView?\n" +
        "    private var realtimeAudioEngine: AVAudioEngine?\n" +
        "    private var realtimeAudioConverter: AVAudioConverter?\n" +
        "    private var realtimeAudioMuted = false",
    );

    // 3) 消息分发：realtimeAudio 分支必须紧贴并早于 blobDownload 分支
    expect(swift).toContain(
      "    func userContentController(_ userContentController: WKUserContentController, " +
        "didReceive message: WKScriptMessage) {\n" +
        '        if message.name == "realtimeAudio" {\n' +
        "            handleRealtimeAudioMessage(message)\n" +
        "            return\n" +
        "        }\n" +
        '        guard message.name == "blobDownload" else { return }',
    );

    // 4) 追加的 private extension 被正确去缩进（这里曾是 \\n 写错的地方）
    expect(swift).toContain("private extension Coordinator {");
    expect(swift).toContain("func handleRealtimeAudioMessage(_ message: WKScriptMessage) {");
    expect(swift).toContain('let action = body["action"] as? String else { return }');
    expect(swift).not.toContain("\n          func handleRealtimeAudioMessage");

    // 5) 调试入口与定位钩子被摘掉
    expect(swift).not.toContain("// enable developer extras");
    // 只摘掉调用点；上游的包装函数声明按原样保留
    expect(swift).not.toContain(
      "context.coordinator.prepareWebGeolocationAuthorization()",
    );
    expect(swift).toContain("func prepareWebGeolocationAuthorization() {");
    // locationManager 本身要保留，只是不再追加字段
    expect(swift).toContain("private var locationManager: CLLocationManager?");

    // 6) vConsole 与 assets 前缀
    expect(existsSync(join(workdir as string, "PakePlus", "vConsole.js"))).toBe(
      false,
    );
    const html = readFileSync(
      join(workdir as string, "PakePlus", "index.html"),
      "utf8",
    );
    expect(html).toContain('<script src="./index-abc123.js">');
    expect(html).not.toContain("./assets/");
  });
});
