import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(resolve("package.json"), "utf8"),
);
const cliPath = resolve("bin/codexhost-mobile.mjs");
const cliSource = readFileSync(cliPath, "utf8");
const serverSource = readFileSync(resolve("server/index.ts"), "utf8");
const isolatedRuntimeDirectory = mkdtempSync(
  `${tmpdir()}/codex-mobile-cli-tests-`,
);
const isolatedRuntimeFile = resolve(
  isolatedRuntimeDirectory,
  "runtime.json",
);

afterAll(() => {
  rmSync(isolatedRuntimeDirectory, { recursive: true, force: true });
});

function isolatedCliEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    CODEX_MOBILE_RUNTIME_FILE: isolatedRuntimeFile,
    ...overrides,
  };
}

describe("npm 全局安装包", () => {
  it("声明公开 CLI、运行时文件和 Node 版本要求", () => {
    expect(packageJson.name).toBe("codexhost-mobile");
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.bin).toEqual({
      "codexhost-mobile": "bin/codexhost-mobile.mjs",
    });
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "bin",
        "dist",
        "npm-dist/server",
        "README.md",
        "LICENSE",
      ]),
    );
    expect(packageJson.engines.node).toBe(">=20");
    expect(packageJson.publishConfig.access).toBe("public");
    expect(packageJson.dependencies).toEqual({
      qrcode: expect.any(String),
      ws: expect.any(String),
    });
  });

  it("prepack 同时构建前端和可直接运行的服务端", () => {
    expect(packageJson.scripts.prepack).toBe("npm run build:package");
    expect(packageJson.scripts["build:package"]).toContain("npm run build");
    expect(packageJson.scripts["build:package"]).toContain(
      "npm run build:server",
    );
  });

  it("CLI 提供帮助和版本信息", () => {
    const help = execFileSync(process.execPath, [cliPath, "--help"], {
      encoding: "utf8",
    });
    const version = execFileSync(process.execPath, [cliPath, "--version"], {
      encoding: "utf8",
    });

    expect(help).toContain("codexhost-mobile start");
    expect(help).toContain("CODEX_MOBILE_TOKEN");
    expect(version.trim()).toBe(packageJson.version);
  });

  it("CLI 拒绝未知命令", () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, "unknown-command"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未知命令");
  });

  it("CLI 输出带访问口令的局域网链接", () => {
    const output = execFileSync(process.execPath, [cliPath, "auth", "--plain"], {
      encoding: "utf8",
      env: isolatedCliEnv({
        HOST: "0.0.0.0",
        PORT: "5173",
        CODEX_MOBILE_TOKEN: "token with spaces",
        CODEX_MOBILE_LAN_IP: "192.168.100.35",
      }),
    });

    expect(output.trim()).toBe(
      "http://192.168.100.35:5173/?token=token+with+spaces",
    );
  });

  it("CLI 默认生成可扫描的终端二维码", () => {
    const output = execFileSync(process.execPath, [cliPath, "auth"], {
      encoding: "utf8",
      env: isolatedCliEnv({
        PORT: "5173",
        CODEX_MOBILE_TOKEN: "secret",
        CODEX_MOBILE_LAN_IP: "192.168.100.35",
      }),
    });

    expect(output).toContain("扫描二维码连接");
    expect(output).toContain(
      "http://192.168.100.35:5173/?token=secret",
    );
  });

  it("CLI 默认使用不常见的 18766 网关端口", () => {
    const output = execFileSync(
      process.execPath,
      [cliPath, "auth", "--plain"],
      {
        encoding: "utf8",
        env: isolatedCliEnv({
          PORT: "",
          CODEX_MOBILE_TOKEN: "secret",
          CODEX_MOBILE_LAN_IP: "192.168.100.35",
        }),
      },
    );

    expect(output.trim()).toBe(
      "http://192.168.100.35:18766/?token=secret",
    );
  });

  it("auth 直接读取 start 保存的端口和口令", () => {
    const directory = mkdtempSync(`${tmpdir()}/codex-mobile-auth-`);
    const runtimeFile = resolve(directory, "runtime.json");
    writeFileSync(
      runtimeFile,
      JSON.stringify({ port: 19000, token: "saved-token" }),
    );
    const output = execFileSync(process.execPath, [cliPath, "auth", "--plain"], {
      encoding: "utf8",
      env: isolatedCliEnv({
        PORT: "19999",
        CODEX_MOBILE_TOKEN: "environment-token",
        CODEX_MOBILE_LAN_IP: "192.168.100.35",
        CODEX_MOBILE_RUNTIME_FILE: runtimeFile,
      }),
    });
    const invalid = spawnSync(
      process.execPath,
      [cliPath, "auth", "--port", "19000"],
      { encoding: "utf8" },
    );
    rmSync(directory, { recursive: true, force: true });

    expect(output.trim()).toBe(
      "http://192.168.100.35:19000/?token=saved-token",
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("未知命令");
  });

  it("start 支持通过 --port 设置网关端口", () => {
    const invalid = spawnSync(
      process.execPath,
      [cliPath, "start", "--port", "invalid"],
      { encoding: "utf8" },
    );

    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("端口");
  });

  it("生成局域网链接时必须配置访问口令", () => {
    const result = spawnSync(process.execPath, [cliPath, "auth"], {
      encoding: "utf8",
      env: isolatedCliEnv({
        CODEX_MOBILE_TOKEN: "",
        CODEX_MOBILE_LAN_IP: "192.168.100.35",
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CODEX_MOBILE_TOKEN");
  });

  it("保留调用目录，并显式传递静态资源目录和版本", () => {
    expect(cliSource).not.toContain("process.chdir(");
    expect(cliSource).toContain("CODEX_MOBILE_STATIC_DIR");
    expect(cliSource).toContain("CODEX_MOBILE_VERSION");
    expect(serverSource).toContain("process.env.CODEX_MOBILE_STATIC_DIR");
    expect(serverSource).toContain("process.env.CODEX_MOBILE_VERSION");
  });

  it("package.json 与 package-lock.json 的根依赖逐项对齐", () => {
    const lock = JSON.parse(
      readFileSync(resolve("package-lock.json"), "utf8"),
    );
    const root = lock.packages[""];
    // 根少声明一项，npm ci 就不再拿锁当事实源，而是重新解析整棵树；
    // 前端依赖漏进 devDependencies 更糟：--production 装出一个白屏的包。
    for (const [name, range] of Object.entries(packageJson.dependencies)) {
      expect(root.dependencies?.[name], `${name} 应出现在锁的 dependencies`).toBe(
        range,
      );
    }
    for (const [name, range] of Object.entries(
      packageJson.devDependencies,
    )) {
      expect(root.devDependencies?.[name], `${name} 应出现在锁的 devDependencies`).toBe(
        range,
      );
    }
    // 锁里多出来的根依赖同样说明漂移，两个方向都要对齐。
    expect(Object.keys(root.dependencies ?? {}).sort()).toEqual(
      Object.keys(packageJson.dependencies).sort(),
    );
    expect(Object.keys(root.devDependencies ?? {}).sort()).toEqual(
      Object.keys(packageJson.devDependencies).sort(),
    );
  });

  it("打包配置不把测试代码编译进 npm-dist", () => {
    const npmTsconfig = JSON.parse(
      readFileSync(resolve("tsconfig.npm.json"), "utf8"),
    );
    // 少了 exclude，server 下的 *.test.ts 会被一起编译进 npm-dist/server，
    // 跟着 tarball 发给用户（codexhost-bridge.test.js 就这么漏出去过）。
    // 注意 tsconfig.npm.json 必须是严格 JSON：这里要用 JSON.parse 读它。
    expect(npmTsconfig.exclude).toEqual(
      expect.arrayContaining(["server/**/*.test.ts"]),
    );
    // 但类型检查必须仍然覆盖测试文件，否则测试代码会悄悄失去类型保护。
    const typecheckTsconfig = JSON.parse(
      readFileSync(resolve("tsconfig.server.json"), "utf8"),
    );
    expect(typecheckTsconfig.include).toContain("server");
    expect(typecheckTsconfig.compilerOptions.noEmit).toBe(true);
  });

  it("运行时代码只导入生产依赖，构建代码的导入都被声明过", () => {
    // 发布出去的包里，真正在用户机器上跑的是 bin/ 和 npm-dist/server
    // （prepack 时由 server/ 编译而来）。这两处 import 的包必须落在
    // dependencies，否则 npm i -g 之后一启动就 MODULE_NOT_FOUND。
    // src/ 相反：它被 vite 整个打进 dist/，构建期用完就扔，
    // 放 devDependencies 才对，放 dependencies 只会让每个用户
    // 白装一份浏览器才用的包（qr-scanner 就踩过这个）。
    const collect = (directory: string, runtime: boolean) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          collect(full, runtime);
          continue;
        }
        // 测试文件不进包（files 里只有 bin/dist/npm-dist/server），
        // 它们 import vitest 这类开发期工具是应该的。
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = readFileSync(full, "utf8");
        for (const match of source.matchAll(
          /(?:from|import)\s+["']([^"']+)["']/g,
        )) {
          const spec = match[1];
          // 相对路径是自家模块，node: 是内置，都不算依赖声明。
          if (/^[./]/.test(spec) || spec.startsWith("node:")) continue;
          const name = spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0];
          const allowed = runtime
            ? Object.keys(packageJson.dependencies)
            : [
                ...Object.keys(packageJson.dependencies),
                ...Object.keys(packageJson.devDependencies),
              ];
          expect(
            allowed,
            runtime
              ? `${full} 是运行时代码，导入了 ${spec} 但它不是生产依赖`
              : `${full} 导入了 ${spec}，但 package.json 里没声明这个包`
          ).toContain(name);
        }
      }
    };

    collect(resolve("bin"), true);
    collect(resolve("server"), true);
    collect(resolve("src"), false);
  });
});
