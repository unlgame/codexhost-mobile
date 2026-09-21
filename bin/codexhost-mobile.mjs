#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";
import {
  describeGatewayConfig,
  loadGatewayConfig,
  resolveConfigPath,
  writeGatewayConfigTemplate,
} from "./codexhost-config.mjs";
import {
  createAccessUrl,
  findLanIPv4,
  readRuntimeAccess,
} from "./access-url.mjs";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const args = process.argv.slice(2);
const command = args[0] ?? "start";
let commandArgs = args.slice(1);
let port = process.env.PORT || "18766";
const runtimeFile =
  process.env.CODEX_MOBILE_RUNTIME_FILE ||
  resolve(homedir(), ".codex-mobile", "runtime.json");

if (command === "start") {
  const remaining = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    if (commandArgs[index] !== "--port") {
      remaining.push(commandArgs[index]);
      continue;
    }
    const value = commandArgs[index + 1];
    const number = Number(value);
    if (
      !value ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > 65535
    ) {
      process.stderr.write("端口必须是 1 到 65535 之间的整数\n");
      process.exit(1);
    }
    port = value;
    index += 1;
  }
  commandArgs = remaining;
}

function printHelp() {
  process.stdout.write(`CodexHost Mobile ${packageJson.version}

用法：
  codexhost-mobile start [--port <端口>]
  codexhost-mobile auth [--plain]
  codexhost-mobile config [--init]
  codexhost-mobile --version
  codexhost-mobile --help


常用流程：
  codexhost-mobile config --init    # 生成配置文件并随机一个访问口令
  codexhost-mobile config           # 查看最终生效的配置
  codexhost-mobile start            # 用配置启动（默认就是本命令）
  codexhost-mobile auth             # 打印配对二维码

配置文件：
  默认写在 %USERPROFILE%\.codex-mobile\config.json（可用 CODEX_MOBILE_CONFIG_FILE 覆盖）。
  同一项配置环境变量优先于配置文件；命令行 --port 优先于两者。

配置文件字段：
  host        监听地址，默认 127.0.0.1；要让手机连就填 0.0.0.0
  port        监听端口，默认 18766
  token       CODEX_MOBILE_TOKEN 局域网访问口令
  mode        CODEX_APP_SERVER_MODE codexhost / managed / external，默认 managed
  bridgePort  CODEXHOST_BRIDGE_PORT codexhost 小桥下游端口，默认 18767
  hostName    CODEX_MOBILE_HOST_NAME 设备显示名称
  uploadDir   CODEX_MOBILE_UPLOAD_DIR 文件上传目录
  lanIp       让 codexhost-mobile auth 固定使用某个局域网 IP

仍然支持环境变量（与配置字段一一对应）：
  HOST                    监听地址，默认 127.0.0.1
  PORT                    监听端口，默认 18766
  CODEX_MOBILE_TOKEN      局域网访问口令
  CODEX_MOBILE_HOST_NAME  设备显示名称
  CODEX_MOBILE_UPLOAD_DIR 文件上传目录
  CODEX_APP_SERVER_MODE   codexhost / managed / external，默认 managed
  CODEXHOST_BRIDGE_PORT   codexhost 小桥下游端口，默认 18767

局域网启动示例：
  写完 config --init 后直接 codexhost-mobile start 即可；
  只想临时改端口：codexhost-mobile start --port 18766
`);
}

if (command === "--help" || command === "-h" || command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "--version" || command === "-v" || command === "version") {
  process.stdout.write(`${packageJson.version}\n`);
  process.exit(0);
}

if (command === "config") {
  const unknown = commandArgs.filter((arg) => arg !== "--init");
  if (unknown.length > 0) {
    // config 只认 --init，多一个字母就当写错——和配置文件里拒绝未知字段同一个道理。
    process.stderr.write(`未知命令：${args.join(" ")}\n`);
    process.exit(1);
  }
  const init = commandArgs.includes("--init");
  if (init) {
    const { path, template } = await writeGatewayConfigTemplate();
    process.stdout.write(
      `已写入 ${path}\n` +
        `token: ${template.token}\n` +
        "把手机端的网关地址填成 http://<本机局域网IP>:18766/?token=<上面的 token>\n",
    );
    process.exit(0);
  }
  const { path, config } = await loadGatewayConfig();
  for (const [key, value] of describeGatewayConfig(process.env, path)) {
    process.stdout.write(`${key.padEnd(12)} ${value}\n`);
  }
  if (Object.keys(config).length === 0) {
    process.stdout.write(
      "\n(尚未创建配置文件，可用 codexhost-mobile config --init 生成)\n",
    );
  }
  process.exit(0);
}

// 未知子命令、以及 start/auth 上多出来的参数，一律在这里拦掉。
// 少了这一句，`auth --port 19000` 这种手误会直接落到启动流程里去起 app-server。

if (
  command === "auth" &&
  (commandArgs.length === 0 ||
    (commandArgs.length === 1 && commandArgs[0] === "--plain"))
) {
  try {
    const runtime = await readRuntimeAccess(runtimeFile);
    const url = createAccessUrl({
      host: process.env.HOST,
      port: runtime?.port ?? port,
      token: runtime?.token ?? process.env.CODEX_MOBILE_TOKEN,
      lanIp: process.env.CODEX_MOBILE_LAN_IP || findLanIPv4(),
    });
    if (commandArgs.includes("--plain")) {
      process.stdout.write(`${url}\n`);
    } else {
      const qrCode = await QRCode.toString(url, {
        type: "terminal",
        small: true,
      });
      process.stdout.write(`扫描二维码连接：\n${qrCode}\n${url}\n`);
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (command !== "start" || commandArgs.length > 0) {
  process.stderr.write(`未知命令：${args.join(" ") || command}\n`);
  printHelp();
  process.exit(1);
}
// --help / --version / config 都不依赖配置文件，已在上面处理完。
// 到这里才读配置：一个写错的 config.json 不会让用户连用法都查不到。
let configPath = null;
let configApplied = [];
try {
  const loaded = await loadGatewayConfig();
  configPath = loaded.path;
  configApplied = Object.keys(loaded.config);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
// 配置已由 loadGatewayConfig 填进 process.env（环境变量优先，不覆盖既有值），
// 这里只补 CLI 自己才知道的那几项。
process.env.PORT = process.env.PORT || port;
process.env.CODEX_MOBILE_RUNTIME_FILE = runtimeFile;
process.env.CODEX_MOBILE_STATIC_DIR = resolve(packageRoot, "dist");
process.env.CODEX_MOBILE_VERSION = packageJson.version;
if (configPath && configApplied.length > 0) {
  process.stdout.write(
    `已读取配置 ${configPath}（${configApplied.join(", ")}）\n`,
  );
}
await import(
  pathToFileURL(resolve(packageRoot, "npm-dist/server/index.js")).href
);
