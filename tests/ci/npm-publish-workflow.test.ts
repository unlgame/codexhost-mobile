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

describe("npm 自动发布流水线", () => {
  it("统一发布流水线传入版本后验证、构建并发布同版本 npm 包", () => {
    const source = readFileSync(
      ".github/workflows/publish-npm.yml",
      "utf8",
    );
    const workflow = parse(source) as PublishWorkflow;
    const steps = workflow.jobs?.publish?.steps ?? [];
    const script = steps.map((step) => step.run ?? "").join("\n");
    const publish = steps.find((step) =>
      step.run?.includes("npm publish"),
    );

    expect(workflow.on?.workflow_call?.inputs?.app_version).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflow.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
    });
    expect(workflow.jobs?.publish?.["runs-on"]).toBe("ubuntu-latest");
    expect(steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(
      true,
    );
    expect(
      steps.some(
        (step) =>
          step.uses?.startsWith("actions/setup-node@") &&
          step.with?.["node-version"] === "24" &&
          step.with?.["registry-url"] === "https://registry.npmjs.org",
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
    const publishWorkflow = parse(
      readFileSync(".github/workflows/publish-npm.yml", "utf8"),
    ) as PublishWorkflow;

    expect(publishWorkflow.on?.workflow_call).toBeDefined();
    expect(publishWorkflow.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
    });

    // 真正执行 npm publish 的步骤只能在这个文件里，
    // 不能挪到 build-android.yml：挪了 OIDC 声明就变了，npm 那边会失配。
    const buildAndroid = parse(
      readFileSync(".github/workflows/build-android.yml", "utf8"),
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
});
