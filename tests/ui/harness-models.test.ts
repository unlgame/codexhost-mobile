import { describe, expect, it } from "vitest";
import {
  harnessModelLabel,
  harnessModelOptionFromEntry,
  harnessPluginName,
  loadHarnessPluginNames,
  resetHarnessPluginNames,
  splitModelCatalog,
} from "../../src/app-server/harness-models";
import { encodeHarnessRoute } from "../../src/app-server/harness-route";
import type { AppServerClient } from "../../src/app-server/client";

const HERMES_ROUTE = encodeHarnessRoute({ harnessId: "hermes", model: "claude-sonnet-4-5" });

describe("model/list 条目归类", () => {
  it("官方模型条目返回 null，保持现状", () => {
    expect(
      harnessModelOptionFromEntry({ model: "gpt-5-codex", displayName: "GPT-5 Codex" }),
    ).toBeNull();
    expect(harnessModelOptionFromEntry({ model: "" })).toBeNull();
    expect(harnessModelOptionFromEntry({})).toBeNull();
    expect(harnessModelOptionFromEntry(null)).toBeNull();
  });

  it("plugin 路由条目归入外部 Harness 并取出路由内的 model", () => {
    expect(harnessModelOptionFromEntry({ model: HERMES_ROUTE })).toEqual({
      model: HERMES_ROUTE,
      harnessId: "hermes",
      routeModel: "claude-sonnet-4-5",
      description: "",
    });
  });

  it("带 selectedHarness 的传输模型 id 也归入外部 Harness", () => {
    expect(
      harnessModelOptionFromEntry({
        model: "codexhost/pi-native@claude-sonnet@high",
        selectedHarness: "pi",
        description: "Claude Sonnet",
      }),
    ).toEqual({
      model: "codexhost/pi-native@claude-sonnet@high",
      harnessId: "pi",
      description: "Claude Sonnet",
    });
  });

  it("坏路由退回 selectedHarness，绝不抛错", () => {
    expect(
      harnessModelOptionFromEntry({
        model: "codexhost/plugin-v1@zz",
        selectedHarness: "qoder",
      }),
    ).toEqual({ model: "codexhost/plugin-v1@zz", harnessId: "qoder", description: "" });
  });

  it("拆分后官方分组与 Harness 分组互不污染", () => {
    const { official, harness } = splitModelCatalog([
      { model: "gpt-5-codex", displayName: "GPT-5 Codex" },
      { model: HERMES_ROUTE },
      { model: "codexhost/pi-native@auto", selectedHarness: "pi" },
    ]);
    expect(official).toEqual([{ model: "gpt-5-codex", displayName: "GPT-5 Codex" }]);
    expect(harness.map((option) => option.harnessId)).toEqual(["hermes", "pi"]);
  });
});

describe("harness 显示名缓存", () => {
  it("取不到 plugins/list 时退回 harnessId", async () => {
    resetHarnessPluginNames();
    expect(harnessPluginName("hermes")).toBe("hermes");
    await loadHarnessPluginNames(null);
    expect(harnessPluginName("hermes")).toBe("hermes");
  });

  it("plugins/list 失败时静默降级", async () => {
    resetHarnessPluginNames();
    const client = {
      request: () => Promise.reject(new Error("Method not found")),
    } as unknown as AppServerClient;
    await loadHarnessPluginNames(client);
    expect(harnessPluginName("hermes")).toBe("hermes");
  });

  it("缓存 plugins/list 的 id/name 并用于标签", async () => {
    resetHarnessPluginNames();
    const client = {
      request: () =>
        Promise.resolve({
          plugins: [
            { id: "hermes", name: "Hermes", version: "1.0.0" },
            { id: " ", name: "忽略空 id" },
            { id: "qoder" },
          ],
        }),
    } as unknown as AppServerClient;
    await loadHarnessPluginNames(client);

    expect(harnessPluginName("hermes")).toBe("Hermes");
    expect(harnessPluginName("qoder")).toBe("qoder");
    expect(
      harnessModelLabel({
        model: HERMES_ROUTE,
        harnessId: "hermes",
        routeModel: "claude-sonnet-4-5",
        description: "",
      }),
    ).toBe("Hermes · claude-sonnet-4-5");
    expect(
      harnessModelLabel({
        model: "codexhost/pi-native@auto",
        harnessId: "pi",
        description: "",
      }),
    ).toBe("pi");
    resetHarnessPluginNames();
  });
});
