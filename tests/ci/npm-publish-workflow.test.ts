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

  it("可信发布要用的工作流名是可调用的那个文件，不是发起调用的那个", () => {
    // npmjs.com 上 Trusted Publisher 的 Workflow filename 必须填
    // publish-npm.yml。原因是 GitHub 的 OIDC 声明里，即便这个 job 是被
    // build-android.yml 用 workflow_call 调起来的，job_workflow_ref 指的
    // 仍然是被调用文件本身。实测：
    //   unlgame/codexhost-mobile/.github/workflows/publish-npm.yml@refs/heads/main
    // 填成 build-android.yml 的话 npm 匹配不上，会静默退化成匿名发布，
    // 最后以 E404 PUT .../codexhost-mobile 收场——曾经就这么红过几次。
    // 所以改名这个文件之前，先去 npm 上把 Trusted Publisher 一起改掉。
    const publishWorkflow = readWorkflow(PUBLISH_WORKFLOW);

    expect(publishWorkflow.on?.workflow_call).toBeDefined();
    expect(publishWorkflow.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
    });

    // 真正执行 npm publish 的步骤只能在这个文件里，
    // 不能挪到 build-android.yml：挪了 OIDC 声明就变了，npm 那边会失配。
    const buildAndroid = parse(
      readFileSync(BUILD_WORKFLOW, "utf8"),
    ) as {
      jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    // 发起调用的那个文件里可以提到 npm publishing（报错信息里就有三处），
    // 但不能真的去执行 npm publish。
    const executedInCaller = Object.values(buildAndroid.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => /\bnpm\s+publish\b/.test(step.run ?? ""));
    expect(executedInCaller).toEqual([]);
    expect(
      Object.values(buildAndroid.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .some((step) => step.run?.includes("publish-npm.yml")),
    ).toBe(true);
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
    // 反过来把 NODE_AUTH_TOKEN 接回来「修好」它是偷懒解法——
    // 那等于往仓库里塞一个长期密钥。
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
});
