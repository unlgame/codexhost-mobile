import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const cliPath = resolve("bin/codexhost-mobile.mjs");

let directory: string;

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("CLI 参数校验", () => {
  // 这条是回归护栏：`auth --port 19000` 以前会被当成合法调用，
  // 一路落到启动流程里去 spawn codex，用户看到的是 app-server ENOENT，
  // 而不是「这个参数不认识」。手误和真故障的表现必须区分开。
  it("auth 带未知参数时报未知命令，不去启动 app-server", () => {
    const result = runCli(["auth", "--port", "19000"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未知命令");
    expect(result.stderr).not.toContain("app-server");
  });

  it("start 带未知参数时报未知命令", () => {
    const result = runCli(["start", "--prot", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未知命令");
  });

  it("config 只接受 --init，多一个字母就当写错", () => {
    const result = runCli(["config", "--foo"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未知命令");
  });

  it("不认识的子命令报未知命令并给出用法", () => {
    const result = runCli(["bogus"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未知命令：bogus");
    expect(result.stdout + result.stderr).toContain("用法");
  });

  it("--port 不是合法端口时报端口错误，而不是崩栈", () => {
    const result = runCli(["start", "--port", "invalid"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("端口");
    expect(result.stderr).not.toContain("at ChildProcess");
  });
});

describe("CLI config --init", () => {
  it("生成带随机口令的配置文件，并打印出来供扫码", () => {
    directory = mkdtempSync(resolve(tmpdir(), "codexhost-cli-init-"));
    const path = resolve(directory, "nested", "config.json");
    const result = runCli(["config", "--init"], {
      CODEX_MOBILE_CONFIG_FILE: path,
      // 清掉可能被外层环境带进来的同项变量，确保读到的是文件里的值。
      PORT: "",
      CODEX_MOBILE_TOKEN: "",
      HOST: "",
      CODEX_APP_SERVER_MODE: "",
      CODEXHOST_BRIDGE_PORT: "",
    });
    expect(result.status).toBe(0);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.host).toBe("0.0.0.0");
    expect(written.mode).toBe("codexhost");
    expect(written.token).toMatch(/^[0-9a-zA-Z_-]{32}$/);
    // 口令必须真的出现在 stdout，否则用户不知道填什么。
    expect(result.stdout).toContain(written.token);
    expect(result.stdout).toContain(path);
  });

  it("配置文件已存在时拒绝覆盖，不把用户改好的口令冲掉", () => {
    directory = mkdtempSync(resolve(tmpdir(), "codexhost-cli-init-"));
    const path = resolve(directory, "config.json");
    writeFileSync(path, JSON.stringify({ token: "keep-me" }), "utf8");
    const result = runCli(["config", "--init"], {
      CODEX_MOBILE_CONFIG_FILE: path,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("已存在");
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("keep-me");
  });

  it("config 打印最终生效值，token 打码不泄露全文", () => {
    directory = mkdtempSync(resolve(tmpdir(), "codexhost-cli-init-"));
    const path = resolve(directory, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ token: "abcdefghijklmnop", port: 18766 }),
      "utf8",
    );
    const result = runCli(["config"], { CODEX_MOBILE_CONFIG_FILE: path });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("abcd********mnop");
    expect(result.stdout).toContain("18766");
    expect(result.stdout).toContain(path);
  });
});
