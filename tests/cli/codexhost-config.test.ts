import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyGatewayConfig,
  describeGatewayConfig,
  generateToken,
  loadGatewayConfig,
  maskToken,
  parseGatewayConfig,
  readGatewayConfigFile,
  resolveConfigPath,
  writeGatewayConfigTemplate,
} from "../../bin/codexhost-config.mjs";

const SOURCE = "C:\\Users\\test\\.codex-mobile\\config.json";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codexhost-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveConfigPath", () => {
  it("默认指向用户目录下的 .codex-mobile/config.json", () => {
    const path = resolveConfigPath({});
    expect(path.replace(/\\/g, "/")).toMatch(/\.codex-mobile\/config\.json$/);
  });

  it("支持 CODEX_MOBILE_CONFIG_FILE 覆盖路径", () => {
    const path = resolveConfigPath({
      CODEX_MOBILE_CONFIG_FILE: "E:/tmp/custom.json",
    });
    // Windows 上 resolve 会把正斜杠归一成反斜杠，所以要单独钉死这一条——
    // 产品主要跑在 Windows，分隔符写错会让用户照着日志找不到文件。
    // POSIX 上 "E:/tmp" 只是个普通片段，会被拼到 cwd 后面，
    // 那是正确行为：那边本来就没有盘符这回事。
    if (process.platform === "win32") {
      expect(path).toBe("E:\\tmp\\custom.json");
    } else {
      // POSIX 没有盘符概念，"E:/tmp/custom.json" 只是普通片段，
      // resolve 会原样拼到 cwd 后面。这里要断言的是片段没被丢掉、
      // 也没被提前截断（拼错就会静默指向别的目录）。
      expect(path.startsWith(process.cwd())).toBe(true);
      expect(path).toContain("E:/tmp/custom.json");
    }
    // 两个平台共同的不变性：必须是绝对路径，且文件名还是用户指定的那个，
    // 否则配置会被写到别处，启动时又读不回来。
    expect(isAbsolute(path)).toBe(true);
    expect(basename(path)).toBe("custom.json");
  });
});

describe("parseGatewayConfig", () => {
  it("接受全部白名单字段并规范化数值", () => {
    const config = parseGatewayConfig(
      {
        host: " 0.0.0.0 ",
        port: 18766,
        token: " secret ",
        mode: "codexhost",
        bridgePort: 18767,
        hostName: "台式机",
        uploadDir: "D:/uploads",
        lanIp: "192.168.1.20",
      },
      SOURCE,
    );
    expect(config).toEqual({
      host: "0.0.0.0",
      port: "18766",
      token: "secret",
      mode: "codexhost",
      bridgePort: "18767",
      hostName: "台式机",
      uploadDir: "D:/uploads",
      lanIp: "192.168.1.20",
    });
  });

  it("顶层不是对象时直接拒绝", () => {
    expect(() => parseGatewayConfig([], SOURCE)).toThrow("顶层必须是一个 JSON 对象");
    expect(() => parseGatewayConfig(null, SOURCE)).toThrow("顶层必须是一个 JSON 对象");
  });

  it("未知字段必须报错：拼错键名被静默忽略比报错难查得多", () => {
    expect(() => parseGatewayConfig({ hosts: "0.0.0.0" }, SOURCE)).toThrow(
      /含未知字段：hosts/,
    );
  });

  it("mode 只接受三种取值", () => {
    expect(() => parseGatewayConfig({ mode: "desktop" }, SOURCE)).toThrow(/mode 必须是/);
    expect(parseGatewayConfig({ mode: "external" }, SOURCE).mode).toBe("external");
  });

  it("端口越界与非整数都被拒绝", () => {
    for (const port of [0, 70000, -1, 65536, 1.5, "", "abc", true]) {
      expect(() => parseGatewayConfig({ port }, SOURCE)).toThrow(
        /port 必须是 1-65535 之间的整数/,
      );
    }
    expect(() => parseGatewayConfig({ bridgePort: -1 }, SOURCE)).toThrow(
      /bridgePort 必须是 0-65535 之间的整数/,
    );
    // bridgePort 允许 0：让小桥自己挑端口。
    expect(parseGatewayConfig({ bridgePort: 0 }, SOURCE).bridgePort).toBe("0");
  });

  it("字符串字段为空串视为无效", () => {
    expect(() => parseGatewayConfig({ token: "   " }, SOURCE)).toThrow(
      /token 必须是非空字符串/,
    );
    expect(() => parseGatewayConfig({ host: 123 }, SOURCE)).toThrow(
      /host 必须是非空字符串/,
    );
  });

  it("空对象等于未配置", () => {
    expect(parseGatewayConfig({}, SOURCE)).toEqual({});
  });
});

describe("applyGatewayConfig", () => {
  it("环境变量已经存在时不被配置文件覆盖", () => {
    const environment = { HOST: "127.0.0.1", CODEX_MOBILE_TOKEN: "from-env" };
    const applied = applyGatewayConfig(
      { host: "0.0.0.0", token: "from-file", mode: "codexhost" },
      environment,
    );
    // 优先级必须是「环境变量 > 配置文件」，否则 CI 里的一次性覆盖会被文件吃回去。
    expect(environment.HOST).toBe("127.0.0.1");
    expect(environment.CODEX_MOBILE_TOKEN).toBe("from-env");
    expect(environment.CODEX_APP_SERVER_MODE).toBe("codexhost");
    // 回报的是环境变量名，方便直接贴到启动日志里。
    expect(applied).toEqual(["CODEX_APP_SERVER_MODE"]);
  });

  it("端口写进 PORT，bridgePort 写进 CODEXHOST_BRIDGE_PORT", () => {
    const environment = {};
    applyGatewayConfig({ port: 19000, bridgePort: 19001 }, environment);
    expect(environment.PORT).toBe("19000");
    expect(environment.CODEXHOST_BRIDGE_PORT).toBe("19001");
  });

  it("返回实际写入的环境变量名，供启动日志回显", () => {
    expect(applyGatewayConfig({ host: "0.0.0.0", port: 1 }, {})).toEqual(["HOST", "PORT"]);
    expect(applyGatewayConfig({}, {})).toEqual([]);
  });
});

describe("describeGatewayConfig", () => {
  it("token 打码显示，不把口令整个打到日志里", () => {
    const described = describeGatewayConfig(
      { CODEX_MOBILE_TOKEN: "abcdefghijkl" },
      null,
    );
    expect(described.find(([key]) => key === "token")?.[1]).toBe("abcd****ijkl");
  });

  it("token 太短时逐字打码，不要留出可猜的部分", () => {
    expect(
      describeGatewayConfig({ CODEX_MOBILE_TOKEN: "abc" }, null).find(
        ([key]) => key === "token",
      )?.[1],
    ).toBe("***");
  });

  it("未设置时明确说明，而不是显示空串", () => {
    expect(
      describeGatewayConfig({}, null).find(([key]) => key === "token")?.[1],
    ).toBe("(未设置)");
  });

  it("未配置项标注默认值来源，配置文件路径单独一行", () => {
    const described = new Map(describeGatewayConfig({}, SOURCE));
    expect(described.get("host")).toMatch(/默认/);
    expect(described.get("bridgePort")).toMatch(/默认/);
    expect(described.get("配置文件")).toBe(SOURCE);
  });
});

describe("generateToken / maskToken", () => {
  it("每次生成的 token 足够长且互不相同", () => {
    const tokens = new Set(Array.from({ length: 32 }, () => generateToken()));
    expect(tokens.size).toBe(32);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-zA-Z_-]{32}$/);
    }
  });

  it("打码保留首尾各 4 位", () => {
    expect(maskToken("0123456789abcdef")).toBe("0123********cdef");
  });
});

describe("readGatewayConfigFile", () => {
  it("文件不存在时返回空配置，让首次启动走模板提示", async () => {
    const path = join(dir, "missing.json");
    const result = await readGatewayConfigFile(process.env, path);
    expect(result).toEqual({ path, config: {} });
  });

  it("JSON 语法错误时给出文件路径", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(readGatewayConfigFile(process.env, path)).rejects.toThrow(path);
  });
});

describe("loadGatewayConfig", () => {
  it("把文件里的配置填进环境变量", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({ host: "0.0.0.0", port: 18766, mode: "codexhost" }),
      "utf8",
    );
    const environment = { CODEX_MOBILE_CONFIG_FILE: path };
    const result = await loadGatewayConfig(environment);
    expect(environment.HOST).toBe("0.0.0.0");
    expect(environment.PORT).toBe("18766");
    expect(environment.CODEX_APP_SERVER_MODE).toBe("codexhost");
    expect(result.config).toEqual({
      host: "0.0.0.0",
      port: "18766",
      mode: "codexhost",
    });
    expect(result.path.replace(/\\/g, "/")).toBe(path.replace(/\\/g, "/"));
  });

  it("配置文件无效时抛出，不让服务带着错配置起来", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ host: "" }), "utf8");
    await expect(
      loadGatewayConfig({ CODEX_MOBILE_CONFIG_FILE: path }),
    ).rejects.toThrow(/host 必须是非空字符串/);
  });
});

describe("writeGatewayConfigTemplate", () => {
  it("生成可直接使用的配置，目录不存在时一并创建", async () => {
    const path = join(dir, "nested", "config.json");
    const result = await writeGatewayConfigTemplate({
      CODEX_MOBILE_CONFIG_FILE: path,
    });
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(result.path.replace(/\\/g, "/")).toBe(path.replace(/\\/g, "/"));
    expect(written.host).toBe("0.0.0.0");
    expect(written.mode).toBe("codexhost");
    expect(written.port).toBe(18766);
    expect(result.template.token).toMatch(/^[0-9a-zA-Z_-]{32}$/);
    expect(written.token).toBe(result.template.token);
  });

  it("已存在配置文件时不覆盖，避免重跑 --init 把用户改好的配置冲掉", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ host: "127.0.0.1" }), "utf8");
    await expect(
      writeGatewayConfigTemplate({ CODEX_MOBILE_CONFIG_FILE: path }),
    ).rejects.toThrow(/已存在/);
  });
});
