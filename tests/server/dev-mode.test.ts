import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { viteDevServerConfig } from "../../server/dev-mode.js";

const packageJson = JSON.parse(
  readFileSync("package.json", "utf8"),
) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

const devLauncher = resolve("bin/dev.mjs");

/** 去掉会干扰「环境文件是否生效」断言的外层变量。 */
function isolatedDevEnv(overrides: NodeJS.ProcessEnv = {}) {
  const {
    CODEX_MOBILE_TOKEN: _token,
    CODEX_MOBILE_ENV_FILE: _envFile,
    CODEX_MOBILE_DEV_DRY_RUN: _dryRun,
    ...rest
  } = process.env;
  return { ...rest, ...overrides };
}

describe("本地调试模式", () => {
  const temporaryDirectories: string[] = [];

  afterAll(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function writeGatewayEnv(content: string) {
    const directory = mkdtempSync(join(tmpdir(), "codexhost-dev-env-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "gateway.env");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("Vite 从局域网 5173 提供页面并代理本机网关", () => {
    expect(viteDevServerConfig).toMatchObject({
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:18766",
          changeOrigin: false,
        },
        "/ws": {
          target: "ws://127.0.0.1:18766",
          changeOrigin: false,
          ws: true,
        },
      },
    });
  });

  it("npm run dev 委托给跨平台启动器，并读取本机网关环境", () => {
    expect(packageJson.scripts.dev).toBe("node bin/dev.mjs");

    const launcher = readFileSync(devLauncher, "utf8");
    expect(launcher).toContain("gateway.env");
    expect(launcher).toContain("concurrently");
    expect(launcher).toContain("--kill-others");
    expect(launcher).toContain("npm:dev:gateway");
    expect(launcher).toContain("npm:dev:web");

    expect(packageJson.devDependencies).toHaveProperty("concurrently");
    expect(packageJson.devDependencies).toHaveProperty("cross-env");

    expect(packageJson.scripts["dev:gateway"]).toContain("tsx watch");
    expect(packageJson.scripts["dev:gateway"]).toContain(
      "CODEX_MOBILE_SERVE_STATIC=false",
    );
    expect(packageJson.scripts["dev:web"]).toContain("vite");
    expect(packageJson.scripts["dev:web"]).toContain("--port 5173");
  });

  it("开发脚本不含 POSIX 专属语法，Windows 上可直接执行", () => {
    for (const name of ["dev", "dev:gateway", "dev:web", "start"]) {
      const script = packageJson.scripts[name];
      expect(script, `${name} 仍依赖 zsh`).not.toContain("zsh");
      // `VAR=value cmd` 是 shell 前缀语法，cmd.exe 不认。
      expect(script, `${name} 仍使用 VAR=value 前缀`).not.toMatch(
        /^[A-Za-z_][A-Za-z0-9_]*=\S/,
      );
    }
  });

  it("干跑模式加载环境文件并给出 concurrently 参数", () => {
    const envFile = writeGatewayEnv(
      [
        "# 本地网关环境",
        "CODEX_MOBILE_TOKEN=dev-token-123",
        "",
        'CODEX_MOBILE_HOST="0.0.0.0"',
        "export CODEX_MOBILE_PORT=18766",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [devLauncher], {
      encoding: "utf8",
      env: isolatedDevEnv({
        CODEX_MOBILE_ENV_FILE: envFile,
        CODEX_MOBILE_DEV_DRY_RUN: "1",
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(
      result.stdout.slice(result.stdout.indexOf("{")),
    ) as { envFile: string; token: string; args: string[] };

    expect(payload.envFile).toBe(envFile);
    expect(payload.token).toBe("dev-token-123");
    expect(payload.args).toEqual(
      expect.arrayContaining([
        "--kill-others",
        "npm:dev:gateway",
        "npm:dev:web",
      ]),
    );
  });

  it("环境文件缺失时告警但不阻塞启动", () => {
    const result = spawnSync(process.execPath, [devLauncher], {
      encoding: "utf8",
      env: isolatedDevEnv({
        CODEX_MOBILE_ENV_FILE: join(tmpdir(), "codexhost-missing-gateway.env"),
        CODEX_MOBILE_DEV_DRY_RUN: "1",
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(
      result.stdout.slice(result.stdout.indexOf("{")),
    ) as { envFile: string | null; token: string | null };

    expect(payload.envFile).toBeNull();
    expect(payload.token).toBeNull();
    expect(result.stderr).toContain("未找到网关环境文件");
  });
});
