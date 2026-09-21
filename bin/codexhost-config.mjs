import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * 配置文件让 `npm install -g` 之后不必每次敲一长串环境变量。
 *
 * 优先级固定为「环境变量 > 配置文件 > 内置默认值」：
 * CI、测试和一次性覆盖继续走环境变量，配置文件只负责补上
 * 「装完之后想持久化」的那一层，两条路互不干扰。
 */
const SETTING_TO_ENV = {
  host: "HOST",
  port: "PORT",
  token: "CODEX_MOBILE_TOKEN",
  mode: "CODEX_APP_SERVER_MODE",
  hostName: "CODEX_MOBILE_HOST_NAME",
  bridgePort: "CODEXHOST_BRIDGE_PORT",
  uploadDir: "CODEX_MOBILE_UPLOAD_DIR",
  lanIp: "CODEX_MOBILE_LAN_IP",
};

const MODES = ["managed", "external", "codexhost"];
const PORT_RANGE = { min: 1, max: 65535 };
const BRIDGE_PORT_RANGE = { min: 0, max: 65535 };

export function resolveConfigPath(environment = process.env) {
  const override = environment.CODEX_MOBILE_CONFIG_FILE?.trim();
  return override
    ? resolve(override)
    : resolve(homedir(), ".codex-mobile", "config.json");
}

function fail(source, message) {
  throw new Error(`配置文件 ${source} 无效：${message}`);
}

function readString(source, key, value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(source, `${key} 必须是非空字符串`);
  }
  return value.trim();
}

function readPort(source, key, value, range) {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  const invalid =
    typeof value === "string"
      ? value.trim() === "" || !Number.isInteger(number)
      : !Number.isInteger(number);
  if (invalid || number < range.min || number > range.max) {
    fail(source, `${key} 必须是 ${range.min}-${range.max} 之间的整数`);
  }
  return String(number);
}

/**
 * 只接受白名单内的键，且逐个校验：配置文件是手写的 JSON，
 * 拼错一个键名如果被静默忽略，用户会以为配上了然后连不上，
 * 这种失败比直接报错难查得多。
 */
export function parseGatewayConfig(raw, source) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`配置文件 ${source} 无效：顶层必须是一个 JSON 对象`);
  }
  const unknown = Object.keys(raw).filter((key) => !(key in SETTING_TO_ENV));
  if (unknown.length > 0) {
    throw new Error(
      `配置文件 ${source} 含未知字段：${unknown.join("、")}。` +
        `可用字段：${Object.keys(SETTING_TO_ENV).join("、")}`,
    );
  }

  const config = {};
  if (raw.host !== undefined) config.host = readString(source, "host", raw.host);
  if (raw.token !== undefined) {
    config.token = readString(source, "token", raw.token);
  }
  if (raw.hostName !== undefined) {
    config.hostName = readString(source, "hostName", raw.hostName);
  }
  if (raw.uploadDir !== undefined) {
    config.uploadDir = readString(source, "uploadDir", raw.uploadDir);
  }
  if (raw.lanIp !== undefined) {
    config.lanIp = readString(source, "lanIp", raw.lanIp);
  }
  if (raw.mode !== undefined) {
    const mode = readString(source, "mode", raw.mode);
    if (!MODES.includes(mode)) {
      fail(source, `mode 必须是 ${MODES.join(" / ")} 之一（当前值：${mode}）`);
    }
    config.mode = mode;
  }
  if (raw.port !== undefined) {
    config.port = readPort(source, "port", raw.port, PORT_RANGE);
  }
  if (raw.bridgePort !== undefined) {
    config.bridgePort = readPort(
      source,
      "bridgePort",
      raw.bridgePort,
      BRIDGE_PORT_RANGE,
    );
  }
  return config;
}

export async function readGatewayConfigFile(
  environment = process.env,
  path = resolveConfigPath(environment),
) {
  if (!existsSync(path)) return { path, config: {} };
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `配置文件 ${path} 不是合法 JSON：${error.message}`,
    );
  }
  return { path, config: parseGatewayConfig(raw, path) };
}

/**
 * 把配置文件里的值填进 process.env，但只在对应环境变量尚未设置时填。
 * 这样既有配置不会被命令行或 CI 的临时覆盖悄悄盖掉。
 */
export function applyGatewayConfig(config, environment = process.env) {
  const applied = [];
  for (const [key, value] of Object.entries(config)) {
    const name = SETTING_TO_ENV[key];
    if (!name) {
      throw new Error(`未知配置项：${key}`);
    }
    if (environment[name] !== undefined && environment[name] !== "") continue;
    // 环境变量的值必须是字符串：直接把数字塞进 process.env，
    // 在 Windows 上传给子进程时会炸成 [object Object] 这类怪东西。
    environment[name] = String(value);
    applied.push(name);
  }
  return applied;
}

export async function loadGatewayConfig(environment = process.env) {
  const { path, config } = await readGatewayConfigFile(environment);
  applyGatewayConfig(config, environment);
  return { path, config };
}

export function generateToken() {
  return randomBytes(24).toString("base64url");
}

/**
 * 首次使用一键落一份模板配置。已存在时拒绝覆盖——
 * 配置文件里放着访问口令，悄悄重写会让用户以为口令没变。
 */
export async function writeGatewayConfigTemplate(
  environment = process.env,
  path = resolveConfigPath(environment),
) {
  if (existsSync(path)) {
    throw new Error(`配置文件 ${path} 已存在，未做修改`);
  }
  const template = {
    host: "0.0.0.0",
    port: 18766,
    token: generateToken(),
    mode: "codexhost",
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { path, template };
}

export function maskToken(token) {
  if (typeof token !== "string" || token === "") return "(未设置)";
  if (token.length <= 8) return "*".repeat(token.length);
  return `${token.slice(0, 4)}${"*".repeat(token.length - 8)}${token.slice(-4)}`;
}

export function describeGatewayConfig(
  environment = process.env,
  path = resolveConfigPath(environment),
) {
  const rows = [
    ["配置文件", path],
    ["host", environment.HOST?.trim() || "127.0.0.1 (默认)"],
    ["port", environment.PORT?.trim() || "18766 (默认)"],
    ["token", maskToken(environment.CODEX_MOBILE_TOKEN)],
    [
      "mode",
      environment.CODEX_APP_SERVER_MODE?.trim() || "managed (默认)",
    ],
    ["hostName", environment.CODEX_MOBILE_HOST_NAME?.trim() || "(取主机名)"],
    [
      "bridgePort",
      environment.CODEXHOST_BRIDGE_PORT?.trim() || "18767 (默认)",
    ],
    ["uploadDir", environment.CODEX_MOBILE_UPLOAD_DIR?.trim() || "(默认目录)"],
  ];
  return rows;
}
