#!/usr/bin/env node
/**
 * 跨平台本地开发启动器。
 *
 * 历史上 `npm run dev` 是一行 zsh 脚本：先 source 本机 gateway.env，再用
 * concurrently 同时拉起网关和 Vite。`zsh -lc` 与 `VAR=value cmd` 前缀都是
 * POSIX 专属语法，Windows 上整条命令直接无法执行。这里改用 Node 实现，
 * macOS / Linux / Windows 行为一致。
 *
 * 环境文件位置：
 *   - CODEX_MOBILE_ENV_FILE 显式指定时优先
 *   - Windows：%APPDATA%\CodexHostWeb\gateway.env
 *   - macOS：~/Library/Application Support/CodexHostWeb\gateway.env
 *     （并继续兼容历史目录 CodexMobileWeb）
 *   - 其他：$XDG_CONFIG_HOME/CodexHostWeb/gateway.env
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";

const isWindows = process.platform === "win32";

function configRoots() {
  if (isWindows) {
    return [process.env.APPDATA || join(homedir(), "AppData", "Roaming")];
  }
  if (process.platform === "darwin") {
    return [join(homedir(), "Library", "Application Support")];
  }
  return [process.env.XDG_CONFIG_HOME || join(homedir(), ".config")];
}

/**
 * 按优先级返回候选环境文件路径。品牌目录统一为 CodexHostWeb；macOS 上额外
 * 兼容历史目录 CodexMobileWeb，免得既有开发机升级后读不到原来的 gateway.env。
 */
function envFileCandidates() {
  const override = process.env.CODEX_MOBILE_ENV_FILE;
  if (override) return [resolve(override)];
  const names =
    process.platform === "darwin"
      ? ["CodexHostWeb", "CodexMobileWeb"]
      : ["CodexHostWeb"];
  return configRoots().flatMap((root) =>
    names.map((name) => join(root, name, "gateway.env")),
  );
}

/** 解析 KEY=VALUE 行，支持注释、空行、export 前缀与成对引号。 */
function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match) continue;
    const raw = match[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    values[match[1]] = quoted ? quoted[2] : raw;
  }
  return values;
}

/**
 * 把环境文件并入 process.env。真实环境变量优先，这样 CI 或一次性覆盖仍然生效。
 * 找不到文件只告警不退出：网关允许空口令本机自用，也允许直接传环境变量。
 */
function loadGatewayEnv() {
  const candidates = envFileCandidates();
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    console.warn(
      `[dev] 未找到网关环境文件（查找过：${candidates.join("、")}）`,
    );
    console.warn(
      "[dev] 可用 CODEX_MOBILE_ENV_FILE 指定路径，或直接用环境变量提供 CODEX_MOBILE_TOKEN。",
    );
    return null;
  }
  for (const [key, value] of Object.entries(
    parseEnvFile(readFileSync(path, "utf8")),
  )) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  console.log(`[dev] 已加载网关环境：${path}`);
  return path;
}

const concurrentlyArgs = [
  "--kill-others",
  "--success",
  "first",
  "--names",
  "gateway,vite",
  "npm:dev:gateway",
  "npm:dev:web",
];

// 干跑模式：只报告解析结果，不启动任何子进程。用于本地排查「口令为什么没生效」，
// 也让启动器本身可以被测试跨平台地验证。
if (process.env.CODEX_MOBILE_DEV_DRY_RUN === "1") {
  const envFile = loadGatewayEnv();
  console.log(
    JSON.stringify(
      {
        envFile,
        token: process.env.CODEX_MOBILE_TOKEN ?? null,
        args: concurrentlyArgs,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

loadGatewayEnv();

const env = { ...process.env };
// 允许脱离 npm run 直接 `node bin/dev.mjs`，此时 node_modules/.bin 不在 PATH 上。
env.PATH = `${resolve("node_modules", ".bin")}${delimiter}${env.PATH ?? ""}`;

// 直接以 node 调用 concurrently 的 JS 入口，不走 shell：
// Windows 上 concurrently 只有 .cmd，经 shell 启动会触发 DEP0190 告警，且信号会被
// shell 吞掉；POSIX 上直接 spawn 才能把 SIGINT 原样传给 concurrently。
const require = createRequire(import.meta.url);
const concurrentlyPackageJson = require.resolve("concurrently/package.json");
const concurrentlyEntry = resolve(
  dirname(concurrentlyPackageJson),
  require(concurrentlyPackageJson).bin.concurrently,
);

const child = spawn(process.execPath, [concurrentlyEntry, ...concurrentlyArgs], {
  stdio: "inherit",
  env,
});

child.on("error", (error) => {
  console.error(`[dev] 启动 concurrently 失败：${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
