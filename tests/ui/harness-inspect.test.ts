import { describe, expect, it, vi } from "vitest";
import {
  HARNESS_INSPECT_METHOD,
  THREAD_MODEL_SELECT_METHOD,
  THREAD_PERMISSION_MODE_SELECT_METHOD,
  THREAD_THINKING_SELECT_METHOD,
  inspectHarness,
  parseHarnessInspection,
  selectThreadModel,
  selectThreadPermissionMode,
  selectThreadThinking,
  thinkingOptionsForModel,
} from "../../src/app-server/harness-inspect";

const READY_PAYLOAD = {
  status: "ready",
  catalog: {
    models: [
      {
        ref: { id: "sonnet-4.6" },
        label: "Sonnet 4.6",
        supportedThinkingOptionIds: ["low", "high"],
      },
      { ref: { id: "opus-4.5" }, label: "Opus 4.5" },
    ],
    defaultModel: { id: "sonnet-4.6" },
    thinkingOptions: [
      { id: "low", label: "低" },
      { id: "high", label: "高" },
      { id: "max", label: "最高" },
    ],
    defaultThinkingOptionId: "low",
  },
  permissionModes: {
    modes: [
      { id: "plan", label: "计划" },
      { id: "acceptEdits", label: "接受编辑", dangerous: true },
    ],
    defaultModeId: "plan",
  },
  capabilities: {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "atCreate",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
};

describe("外部 harness 探测", () => {
  it("解析 ready 响应里的模型、思考档位、权限模式与能力", () => {
    const inspection = parseHarnessInspection(READY_PAYLOAD);

    expect(inspection.status).toBe("ready");
    expect(inspection.models.map((model) => model.id)).toEqual([
      "sonnet-4.6",
      "opus-4.5",
    ]);
    expect(inspection.models[0].thinkingOptionIds).toEqual(["low", "high"]);
    expect(inspection.defaultModelId).toBe("sonnet-4.6");
    expect(inspection.thinkingOptions.map((option) => option.id)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(inspection.defaultThinkingOptionId).toBe("low");
    expect(inspection.permissionModes.map((mode) => mode.id)).toEqual([
      "plan",
      "acceptEdits",
    ]);
    expect(inspection.permissionModes[1].dangerous).toBe(true);
    expect(inspection.defaultPermissionModeId).toBe("plan");
    expect(inspection.capabilities).toEqual({
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "atCreate",
    });
  });

  it("不可用状态保留上游原文并清空目录", () => {
    const inspection = parseHarnessInspection({
      status: "notInstalled",
      error: { code: -32077, message: "Claude Code CLI not found" },
    });

    expect(inspection.status).toBe("notInstalled");
    expect(inspection.errorMessage).toBe("Claude Code CLI not found");
    expect(inspection.models).toEqual([]);
    expect(inspection.capabilities.selectModel).toBe(false);
  });

  it("字段缺失或类型不对时退化成不可用而不是崩掉", () => {
    // 响应来自跨进程 JSON-RPC，不能假设它一定符合 schema。
    const inspection = parseHarnessInspection({ status: "ready" });

    expect(inspection.status).toBe("ready");
    expect(inspection.models).toEqual([]);
    expect(inspection.thinkingOptions).toEqual([]);
    expect(inspection.permissionModes).toEqual([]);
    expect(inspection.capabilities).toEqual({
      selectModel: false,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live",
    });

    expect(parseHarnessInspection(null).status).toBe("error");
    expect(parseHarnessInspection({ status: "wat" }).status).toBe("error");
  });

  it("按模型过滤思考档位，模型未声明时给全量", () => {
    const inspection = parseHarnessInspection(READY_PAYLOAD);

    expect(
      thinkingOptionsForModel(inspection, "sonnet-4.6").map((o) => o.id),
    ).toEqual(["low", "high"]);
    // opus-4.5 没有 supportedThinkingOptionIds → 不限制。
    expect(
      thinkingOptionsForModel(inspection, "opus-4.5").map((o) => o.id),
    ).toEqual(["low", "high", "max"]);
    expect(thinkingOptionsForModel(inspection, "missing").map((o) => o.id)).toEqual(
      ["low", "high", "max"],
    );
  });

  it("探测时带上 cwd，会话中的三个 select 用协议要求的参数形状", async () => {
    const request = vi.fn(async () => READY_PAYLOAD);

    await inspectHarness({ request } as any, "claude-code", "C:/work");
    expect(request).toHaveBeenCalledWith(HARNESS_INSPECT_METHOD, {
      harnessId: "claude-code",
      cwd: "C:/work",
    });

    const selectRequest = vi.fn(async () => ({}));
    await selectThreadModel({ request: selectRequest } as any, "thread-1", "opus-4.5");
    expect(selectRequest).toHaveBeenCalledWith(THREAD_MODEL_SELECT_METHOD, {
      threadId: "thread-1",
      // 协议里 model 是 { id } 对象，不是裸字符串。
      model: { id: "opus-4.5" },
    });

    await selectThreadThinking({ request: selectRequest } as any, "thread-1", "high");
    expect(selectRequest).toHaveBeenCalledWith(THREAD_THINKING_SELECT_METHOD, {
      threadId: "thread-1",
      thinkingOptionId: "high",
    });

    await selectThreadPermissionMode(
      { request: selectRequest } as any,
      "thread-1",
      "plan",
    );
    expect(selectRequest).toHaveBeenCalledWith(
      THREAD_PERMISSION_MODE_SELECT_METHOD,
      { threadId: "thread-1", permissionModeId: "plan" },
    );
  });
});
