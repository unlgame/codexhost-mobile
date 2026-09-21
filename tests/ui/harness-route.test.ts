import { describe, expect, it } from "vitest";
import {
  decodeHarnessRoute,
  encodeHarnessRoute,
  harnessRouteLabel,
  HARNESS_ROUTE_PREFIX,
  isHarnessRouteValue,
  tryDecodeHarnessRoute,
} from "../../src/app-server/harness-route";

/**
 * Golden vectors below were produced by codex-host's own
 * `encodeHarnessPluginRoute` (packages/shared-contracts/src/harness-route.ts,
 * verified against packages/shared-contracts/dist/harness-route.js). They pin
 * the byte-for-byte wire format so the two sides can never drift.
 */
const GOLDEN = {
  harnessIdOnly: "codexhost/plugin-v1@7b226861726e6573734964223a226865726d6573227d",
  qoder: "codexhost/plugin-v1@7b226861726e6573734964223a22716f646572227d",
  hyphenatedId: "codexhost/plugin-v1@7b226861726e6573734964223a22636c617564652d636f6465227d",
  dottedId: "codexhost/plugin-v1@7b226861726e6573734964223a22612e622d635f64227d",
  shortId: "codexhost/plugin-v1@7b226861726e6573734964223a2261623132227d",
  singleChar: "codexhost/plugin-v1@7b226861726e6573734964223a2261227d",
  objectModel:
    "codexhost/plugin-v1@7b226861726e6573734964223a226865726d6573222c226d6f64656c223a7b226964223a22636c617564652d736f6e6e65742d342d35227d7d",
  allFields:
    "codexhost/plugin-v1@7b226861726e6573734964223a22716f646572222c226d6f64656c223a7b226964223a226175746f227d2c227468696e6b696e674f7074696f6e4964223a2268696768222c227065726d697373696f6e4d6f64654964223a226163636570744564697473227d",
  modelOnly:
    "codexhost/plugin-v1@7b226861726e6573734964223a226865726d6573222c226d6f64656c223a7b226964223a226d31227d7d",
  modelPermission:
    "codexhost/plugin-v1@7b226861726e6573734964223a226865726d6573222c226d6f64656c223a7b226964223a226d31227d2c227065726d697373696f6e4d6f64654964223a22706c616e227d",
  modelThinking:
    "codexhost/plugin-v1@7b226861726e6573734964223a22716f646572222c226d6f64656c223a7b226964223a226175746f227d2c227468696e6b696e674f7074696f6e4964223a2268696768227d",
  transportSafeModel:
    "codexhost/plugin-v1@7b226861726e6573734964223a2278222c226d6f64656c223a7b226964223a22412d5a612d7a302d392e5f7e2d227d7d",
} as const;

function hex(json: string) {
  return [...json].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

describe("harness 路由编解码", () => {
  it("按 codex-host 的金样字节编解码 harnessId", () => {
    expect(encodeHarnessRoute({ harnessId: "hermes" })).toBe(GOLDEN.harnessIdOnly);
    expect(decodeHarnessRoute(GOLDEN.harnessIdOnly)).toEqual({ harnessId: "hermes" });
    expect(encodeHarnessRoute({ harnessId: "qoder" })).toBe(GOLDEN.qoder);
    expect(encodeHarnessRoute({ harnessId: "claude-code" })).toBe(GOLDEN.hyphenatedId);
    expect(encodeHarnessRoute({ harnessId: "a.b-c_d" })).toBe(GOLDEN.dottedId);
    expect(encodeHarnessRoute({ harnessId: "ab12" })).toBe(GOLDEN.shortId);
    expect(encodeHarnessRoute({ harnessId: "a" })).toBe(GOLDEN.singleChar);
  });

  it("codex-host 用 { id } 承载 model，本端归一成字符串", () => {
    expect(decodeHarnessRoute(GOLDEN.objectModel)).toEqual({
      harnessId: "hermes",
      model: "claude-sonnet-4-5",
    });
    expect(decodeHarnessRoute(GOLDEN.modelOnly)).toEqual({
      harnessId: "hermes",
      model: "m1",
    });
    expect(decodeHarnessRoute(GOLDEN.modelPermission)).toEqual({
      harnessId: "hermes",
      model: "m1",
      permissionModeId: "plan",
    });
    expect(decodeHarnessRoute(GOLDEN.modelThinking)).toEqual({
      harnessId: "qoder",
      model: "auto",
      thinkingOptionId: "high",
    });
  });

  it("完整字段的金样路由可解码且顺序固定", () => {
    expect(decodeHarnessRoute(GOLDEN.allFields)).toEqual({
      harnessId: "qoder",
      model: "auto",
      thinkingOptionId: "high",
      permissionModeId: "acceptEdits",
    });
  });

  it("transport-safe 字符集的 model 金样可解码", () => {
    expect(decodeHarnessRoute(GOLDEN.transportSafeModel)).toEqual({
      harnessId: "x",
      model: "A-Za-z0-9._~-",
    });
  });

  it("往返保持一致（encode(decode(x)) === x）", () => {
    const routes = [
      { harnessId: "hermes" },
      { harnessId: "qoder", model: "auto" },
      { harnessId: "qoder", model: "auto", thinkingOptionId: "high" },
      {
        harnessId: "qoder",
        model: "auto",
        thinkingOptionId: "high",
        permissionModeId: "acceptEdits",
      },
      { harnessId: "a.b-c_d", permissionModeId: "plan" },
    ];
    for (const route of routes) {
      const encoded = encodeHarnessRoute(route);
      expect(encodeHarnessRoute(decodeHarnessRoute(encoded)!)).toBe(encoded);
      expect(decodeHarnessRoute(encoded)).toEqual(route);
    }
  });

  it("前缀即协议声明", () => {
    expect(HARNESS_ROUTE_PREFIX).toBe("codexhost/plugin-v1@");
    expect(isHarnessRouteValue(GOLDEN.harnessIdOnly)).toBe(true);
    expect(isHarnessRouteValue("gpt-5")).toBe(false);
    expect(isHarnessRouteValue(undefined)).toBe(false);
  });

  it("非本协议的取值返回 null 而不抛错", () => {
    for (const value of [
      "gpt-5-codex",
      "codexhost/plugin-v2@7b7d",
      "codexhost/pi-native@claude-sonnet",
      "",
      "   ",
      null,
      undefined,
      42,
      {},
      [],
      { harnessId: "hermes" },
    ]) {
      expect(decodeHarnessRoute(value)).toBeNull();
    }
  });

  it("空载荷、非 hex、奇数 hex、超长一律抛错", () => {
    for (const value of [
      HARNESS_ROUTE_PREFIX,
      `${HARNESS_ROUTE_PREFIX}zz`,
      `${HARNESS_ROUTE_PREFIX}7b`,
      `${HARNESS_ROUTE_PREFIX}${"61".repeat(2100)}`,
      `${HARNESS_ROUTE_PREFIX}${"7B".repeat(10)}`,
    ]) {
      expect(() => decodeHarnessRoute(value)).toThrow("Invalid Harness plugin route");
    }
  });

  it("非 canonical 载荷（键序、空白、大写 hex）抛错", () => {
    const swapped = `${HARNESS_ROUTE_PREFIX}${hex('{"model":"m","harnessId":"a"}')}`;
    const pretty = `${HARNESS_ROUTE_PREFIX}${hex(JSON.stringify({ harnessId: "a" }, null, 1))}`;
    expect(() => decodeHarnessRoute(swapped)).toThrow("Invalid Harness plugin route");
    expect(() => decodeHarnessRoute(pretty)).toThrow("Invalid Harness plugin route");
  });

  it("载荷不是对象或字段非法时抛错", () => {
    for (const payload of [
      "5b5d",
      "31",
      "6e756c6c",
      "227822",
      hex('{"harnessId":null}'),
      hex('{"harnessId":"a","model":{}}'),
      hex('{"harnessId":"a","model":{"id":"m","extra":1}}'),
      hex('{"harnessId":"a","model":{"id":"bad id"}}'),
      hex('{"harnessId":"a","model":"bad id"}'),
      hex('{"harnessId":"a","extra":1}'),
      hex('{"harnessId":""}'),
      hex('{"harnessId":"  "}'),
      hex('{"harnessId":"codex"}'),
      hex('{"harnessId":"Codex"}'),
      hex('{"harnessId":"-abc"}'),
      hex('{"harnessId":"abc-"}'),
      hex('{"harnessId":"a--b"}'),
      hex('{"harnessId":"a b"}'),
      hex(`{"harnessId":"${"a".repeat(129)}"}`),
      hex('{"harnessId":"a","model":{"id":""}}'),
      hex(`{"harnessId":"a","model":{"id":"${"m".repeat(513)}"}}`),
      hex('{"harnessId":"a","thinkingOptionId":""}'),
      hex(`{"harnessId":"a","thinkingOptionId":"${"t".repeat(129)}"}`),
      hex('{"harnessId":"a","permissionModeId":"p p"}'),
      hex(`{"harnessId":"a","permissionModeId":"${"p".repeat(129)}"}`),
    ]) {
      expect(() => decodeHarnessRoute(`${HARNESS_ROUTE_PREFIX}${payload}`)).toThrow(
        "Invalid Harness plugin route",
      );
    }
  });

  it("encode 侧同样拒绝非法入参", () => {
    for (const route of [
      { harnessId: "" },
      { harnessId: "codex" },
      { harnessId: "a", model: "bad id" },
      { harnessId: "a", model: "" },
      { harnessId: "a", extra: 1 } as unknown as { harnessId: string },
      { harnessId: "a", thinkingOptionId: "t t" },
    ]) {
      expect(() => encodeHarnessRoute(route)).toThrow("Invalid Harness plugin route");
    }
  });

  it("显式 undefined 的可选项与省略等价", () => {
    expect(encodeHarnessRoute({ harnessId: "a", model: undefined })).toBe(GOLDEN.singleChar);
    expect(
      encodeHarnessRoute({
        harnessId: "a",
        model: undefined,
        thinkingOptionId: undefined,
        permissionModeId: undefined,
      }),
    ).toBe(GOLDEN.singleChar);
  });

  it("tryDecodeHarnessRoute 对坏路由降级为 null", () => {
    expect(tryDecodeHarnessRoute(GOLDEN.harnessIdOnly)).toEqual({ harnessId: "hermes" });
    expect(tryDecodeHarnessRoute(`${HARNESS_ROUTE_PREFIX}zz`)).toBeNull();
    expect(tryDecodeHarnessRoute("gpt-5")).toBeNull();
  });

  it("标签拼接显示名与路由内的 model", () => {
    expect(harnessRouteLabel({ harnessId: "hermes" }, "Hermes")).toBe("Hermes");
    expect(harnessRouteLabel({ harnessId: "hermes", model: "m1" }, "Hermes")).toBe(
      "Hermes · m1",
    );
    expect(harnessRouteLabel({ harnessId: "hermes", model: "m1" })).toBe("hermes · m1");
    expect(harnessRouteLabel({ harnessId: "hermes" }, "   ")).toBe("hermes");
  });
});
