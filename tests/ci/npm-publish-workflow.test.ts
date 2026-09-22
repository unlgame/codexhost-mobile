import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface PublishWorkflow {
  on?: {
    workflow_call?: {
      inputs?: {
        app_version?: {
          required?: boolean;
          type?: string;
        };
      };
    };
  };
  permissions?: {
    contents?: string;
    "id-token"?: string;
  };
  jobs?: {
    publish?: {
      "runs-on"?: string;
      steps?: Array<{
        uses?: string;
        with?: Record<string, unknown>;
        run?: string;
        env?: Record<string, string>;
      }>;
    };
  };
}

const PUBLISH_WORKFLOW = ".github/workflows/publish-npm.yml";
const BUILD_WORKFLOW = ".github/workflows/build-android.yml";

function readWorkflow(path: string) {
  return parse(readFileSync(path, "utf8")) as PublishWorkflow;
}

describe("npm 自动发布流水线", () => {
  it("统一发布流水线传入版本后验证、构建并发布同版本 npm 包", () => {
    const source = readFileSync(PUBLISH_WORKFLOW, "utf8");
    const workflow = parse(source) as PublishWorkflow;
    const steps = workflow.jobs?.publish?.steps ?? [];
    const script = steps.map((step) => step.run ?? "").join("\n");
    const publish = steps.find((step) => step.run?.includes("npm publish"));

    expect(workflow.on?.workflow_call?.inputs?.app_version).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflow.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
    });
    expect(workflow.jobs?.publish?.["runs-on"]).toBe("ubuntu-latest");
    expect(
      steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    ).toBe(true);
    expect(
      steps.some(
        (step) =>
          step.uses?.startsWith("actions/setup-node@") &&
          step.with?.["node-version"] === "24",
      ),
    ).toBe(true);
    expect(script).toContain("npm ci");
    expect(script).toContain("npm test");
    expect(script).toContain("npm run build:package");
    expect(script).toContain("npm version");
    expect(source).toContain("inputs.app_version");
    expect(script).toContain("npm publish --access public");
    expect(script).not.toContain("--provenance");
    expect(publish?.env?.NODE_AUTH_TOKEN).toBeUndefined();
    expect(source).not.toContain("NPM_TOKEN");
  });

  it("可信发布要用的工作流名是发起调用的那个文件，不是真正执行发布的那个", () => {
    // npmjs.com 上 Trusted Publisher 的 Workflow filename 必须填
    // build-android.yml——「发起调用」的那个文件，而不是真正跑 npm publish
    // 的 publish-npm.yml。
    //
    // 官方文档 trusted-publishers#troubleshooting 原文：
    //   Some GitHub Actions workflows use `workflow_call` to invoke other
    //   workflows that run `npm publish`, or use `workflow_dispatch` for
    //   manual publishing. When this happens, validation checks the calling
    //   workflow's name instead of the workflow that actually contains the
    //   publish command, which can cause configuration mismatches.
    //
    // 这条极容易搞反：GitHub 的 OIDC 声明里 job_workflow_ref 明明指向被调用的
    //   unlgame/codexhost-mobile/.github/workflows/publish-npm.yml@refs/heads/main
    // 但 npm 校验的不是它。曾经照着 job_workflow_ref 把配置改成 publish-npm.yml，
    // 结果把本来对的配置改坏了——症状是 oidc.js 静默 return，最后只剩一个
    // ENEEDAUTH，日志里完全看不出原因。
    //
    // 所以：改名 build-android.yml 之前，先去 npm 上把 Trusted Publisher 一起改掉。
    const publishWorkflow = readWorkflow(PUBLISH_WORKFLOW);

    expect(publishWorkflow.on?.workflow_call).toBeDefined();
    expect(publishWorkflow.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
    });

    const buildAndroid = parse(readFileSync(BUILD_WORKFLOW, "utf8")) as {
      jobs?: Record<
        string,
        {
          uses?: string;
          permissions?: Record<string, string>;
          steps?: Array<{ run?: string }>;
        }
      >;
    };

    // 必须真的有一个 job 用 workflow_call 调 publish-npm.yml——npm 那边要填的
    // 就是这个调用方文件的名字，两者得对得上。
    const callers = Object.entries(buildAndroid.jobs ?? {}).filter(
      ([, job]) => job.uses === "./.github/workflows/publish-npm.yml",
    );
    expect(
      callers,
      "build-android.yml 必须有一个 job 用 workflow_call 调 publish-npm.yml",
    ).toHaveLength(1);

    // 父工作流也要给 id-token: write，缺了同样换不到 OIDC 令牌。
    expect(callers[0]?.[1].permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
    });

    // 调用方自己不能执行 npm publish。真挪过去了，「调用方」和「执行方」就是
    // 同一个文件，这条规则无从谈起，npm 那边的配置会静默失配。
    const executedInCaller = Object.values(buildAndroid.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => /\bnpm\s+publish\b/.test(step.run ?? ""));
    expect(executedInCaller).toEqual([]);
  });

  it("setup-node 不带 registry-url，否则可信发布被它写错令牌堵死", () => {
    // setup-node 的 node-auth-token 默认值是 ${{ github.token }}。
    // 一传 registry-url，它就会同时做两件事：
    //   1. 往 $RUNNER_TEMP/.npmrc 写
    //        //registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}
    //   2. 把 NODE_AUTH_TOKEN 默认成那个 github.token
    //      （CI 日志里脱敏成 XXXXX-XXXXX-XXXXX-XXXXX 的那个）
    //
    // npm 的推理链于是变成：registry 配了令牌 → 不用走可信发布 →
    // 拿它去 PUT → 它当然不是 npm 凭据 → 404。
    //
    // registry 对未授权发布一律回 404，和「包不存在」是同一个码，
    // 所以这个坑长得像 Trusted Publisher 没配对，排查时容易一路走错方向。
    // 日志里那句「npm tokens that bypass 2FA are being restricted」是铁证：
    // npm 以为自己手里有令牌。
    //
    // 修法只有一条：不给 registry-url。可信发布本来就不需要它，
    // 删掉之后 .npmrc 和 NODE_AUTH_TOKEN 两个问题一起消失。
    // 2026-08-18 用一次性探针脚本验证过，证据是：
    //   GitHub id_token: 200 <received>        → id-token: write 正常
    //   registry exchange: 404
    //     {"message":"OIDC token exchange error - package not found"}
    // 也就是说这一步只解决「别自己堵死 OIDC」，后面还卡着 npm 注册表
    // 侧的 Trusted Publisher。那个得登录 npmjs.com 手工配：
    //   https://www.npmjs.com/package/codexhost-mobile/access
    // 填 Organizations or users = unlgame、Repository = codexhost-mobile、
    //   Workflow filename = build-android.yml（见上一个测试，不能填 publish-npm.yml）
    // 没配对就让 exchange 直接 404，oidc.js 静默 return，症状只有
    // ENEEDAUTH——凭日志看不出来，所以别再把这类静默失败当成本仓库 bug 查。
    //
    // exchange 的两个失败码可以区分（2026-09-22 实测，手工 POST 该端点）：
    //   401 {"message":"OIDC token exchange error - unauthorized"}
    //       → 令牌本身不合法，问题在 GitHub 侧
    //   404 {"message":"OIDC token exchange error - package not found"}
    //       → 令牌合法，但注册表里没有一条能匹配上它的可信发布配置
    // 看到 404 就去查配置，别去查 GitHub 权限。
    //
    // 另一条官方硬要求：package.json 的 repository.url 必须精确等于
    // GitHub 仓库地址（见下面那条测试），仓库改名后忘了同步它同样发不出去。
    // 反面教材同样是长期密钥：把 NODE_AUTH_TOKEN 接回来「修好」它是偷懒解法。
    const workflow = readWorkflow(PUBLISH_WORKFLOW);
    const steps = workflow.jobs?.publish?.steps ?? [];
    const setupNodes = steps.filter((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );

    expect(setupNodes, "应该只有一个 setup-node 步骤").toHaveLength(1);
    expect(setupNodes[0]?.with?.["node-version"]).toBe("24");
    expect(
      setupNodes[0]?.with?.["registry-url"],
      "setup-node 不能带 registry-url：它会写 _authToken 占位并把 NODE_AUTH_TOKEN 默认成 github.token，可信发布的 OIDC 流程就被堵死了",
    ).toBeUndefined();
  });

  it("别再往流水线里加「删 _authToken 占位」的补救步骤", () => {
    // 曾经有人（就是我）在 npm publish 前加过一个步骤，想删掉 setup-node
    // 写的令牌占位。它看着对症，其实什么都没做，因为它读的是
    // 仓库根目录的 .npmrc，而 setup-node 写的是 $RUNNER_TEMP/.npmrc。
    // 结果那一步直接短路：
    //   cat .npmrc 2>/dev/null || echo "(none)"   →   "(none)"
    // 真正的修法是不给 registry-url，不是事后擦屁股。
    // 这个测试确保别有人再把这种空转步骤塞回来顶替本来的修法。
    const workflow = readWorkflow(PUBLISH_WORKFLOW);
    const steps = workflow.jobs?.publish?.steps ?? [];
    const stripSteps = steps.filter(
      (step) =>
        /_authToken/.test(step.run ?? "") && /npmrc/i.test(step.run ?? ""),
    );

    expect(
      stripSteps,
      "setup-node 写的是 $RUNNER_TEMP/.npmrc，那种删仓库根目录 .npmrc 的步骤跑起来会直接短路，请去掉 registry-url",
    ).toEqual([]);
  });

  it("别让人把 npm 发布改回用长期 NPM_TOKEN 顶上", () => {
    // ENEEDAUTH 看着像一个凭据问题，很容易顺手指「加个 NPM_TOKEN 就好了」。
    // 那条路和这次排查的初衷是拧着的：要的就是仓库里不落长期密钥。
    // 真要让发布跑起来，是去 npmjs.com 配 Trusted Publisher（见上面两条测试），
    // 不是往仓库塞一个还得手改的 secret。
    const source = readFileSync(PUBLISH_WORKFLOW, "utf8");
    const workflow = readWorkflow(PUBLISH_WORKFLOW);
    const steps = workflow.jobs?.publish?.steps ?? [];

    // 上面几条测试是按 setup-node 的 with 块说的，这里换到 secrets 侧：
    // 这个文件根本不该也不该引用任何 secret。可信发布靠的是 OIDC 的
    // id_token，不是一个 long-lived secret。
    for (const step of steps) {
      expect(step.env ?? {}).not.toHaveProperty("NODE_AUTH_TOKEN");
      expect(step.env ?? {}).not.toHaveProperty("NPM_TOKEN");
    }
    expect(source).not.toMatch(/secrets\./);
  });

  it("package.json 的 repository.url 必须指向这个 GitHub 仓库", () => {
    // 官方文档 trusted-publishers 的另一条硬要求：
    //   To publish from GitHub, your package's `repository.url` field in
    //   `package.json` must exactly match your GitHub repository.
    // 仓库从 loock-ai/codex-mobile 改名到 unlgame/codexhost-mobile 之后，
    // 这里忘了同步就会静默发不出去，症状同样是只剩一个 ENEEDAUTH。
    //
    // 不钉死写法（git+ / .git 后缀都合法），只要求指向同一个仓库，
    // 这样既拦得住改名遗漏，也不会因为换个等价写法就误报。
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      name?: string;
      repository?: { url?: string };
    };

    expect(pkg.name).toBe("codexhost-mobile");
    expect(pkg.repository?.url).toMatch(
      /^(git\+)?https:\/\/github\.com\/unlgame\/codexhost-mobile(\.git)?$/,
    );
  });
});
