import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ThreadUsageChip,
  ThreadUsagePanel,
} from "../../src/features/conversation/ConversationControls";
import { threadUsageFields } from "../../src/app-server/thread-usage";
import { ComposerSettings } from "../../src/features/settings/ComposerSettings";
import { encodeHarnessRoute } from "../../src/app-server/harness-route";

const USAGE = threadUsageFields({
  inputTokens: 424_100,
  cachedInputTokens: 7_600_000,
  cacheWriteInputTokens: 0,
  outputTokens: 102_400,
  totalTokens: 8_100_000,
  totalCostUsd: 0,
  contextUsedTokens: 77_000,
  contextWindowTokens: 1_000_000,
  planFiveHourUsedPercent: 12,
  planSevenDayUsedPercent: 34,
});

afterEach(cleanup);

describe("用量 chip 与展开面板", () => {
  it("chip 只显示上下文占比，并暴露展开状态", () => {
    const { container } = render(
      <ThreadUsageChip usage={USAGE} expanded={false} onToggle={() => undefined} />,
    );
    const chip = container.querySelector(".thread-usage-chip");
    expect(chip?.textContent).toBe("上下文 7.7%");
    expect(chip?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "查看用量" })).not.toBeNull();
  });

  it("没有用量数据时 chip 退化为「用量」", () => {
    const { container } = render(
      <ThreadUsageChip usage={null} expanded={false} onToggle={() => undefined} />,
    );
    expect(container.querySelector(".thread-usage-chip")?.textContent).toBe("用量");
  });

  it("点击 chip 可以切换展开与收起", () => {
    const onToggle = vi.fn();
    render(<ThreadUsageChip usage={USAGE} expanded={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "查看用量" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("展开后面板按参考文本排版", () => {
    const { container } = render(
      <ThreadUsagePanel
        open
        usage={USAGE}
        onClose={() => undefined}
        onOpenStatus={() => undefined}
      />,
    );
    const panel = container.querySelector(".thread-usage-panel");
    expect(panel?.classList.contains("open")).toBe(true);
    expect(panel?.getAttribute("aria-hidden")).toBe("false");
    const rows = Array.from(panel?.querySelectorAll("dt") ?? []).map((node) => [
      node.textContent,
      node.nextElementSibling?.textContent,
    ]);
    expect(rows).toEqual([
      ["上下文", "7.7% / 1M"],
      ["缓存读取", "7.6M"],
      ["缓存写入", "0"],
      ["Token 总数", "8.1M"],
      ["输入 / 输出", "424.1k / 102.4k"],
      ["会话费用估算", "$0.000"],
      ["5 小时限额", "12.0%"],
      ["7 天限额", "34.0%"],
    ]);
  });

  it("收起时面板不可见", () => {
    const { container } = render(
      <ThreadUsagePanel
        open={false}
        usage={USAGE}
        onClose={() => undefined}
        onOpenStatus={() => undefined}
      />,
    );
    const panel = container.querySelector(".thread-usage-panel");
    expect(panel?.classList.contains("open")).toBe(false);
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
  });

  it("字段全部缺失时优雅降级，不崩溃", () => {
    const { container } = render(
      <ThreadUsagePanel
        open
        usage={null}
        onClose={() => undefined}
        onOpenStatus={() => undefined}
      />,
    );
    expect(screen.getByText("暂无用量数据")).not.toBeNull();
    expect(container.querySelector(".thread-usage-panel")).not.toBeNull();
  });

  it("部分字段缺失显示占位符", () => {
    const partial = threadUsageFields({ inputTokens: 5 });
    const { container } = render(
      <ThreadUsagePanel
        open
        usage={partial}
        onClose={() => undefined}
        onOpenStatus={() => undefined}
      />,
    );
    const values = Array.from(container.querySelectorAll("dd")).map((node) => node.textContent);
    expect(values).toEqual(["—", "—", "—", "—", "5 / —", "—"]);
  });

  it("面板提供进入会话状态的入口", () => {
    const onOpenStatus = vi.fn();
    const onClose = vi.fn();
    render(
      <ThreadUsagePanel
        open
        usage={USAGE}
        onClose={onClose}
        onOpenStatus={onOpenStatus}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "收起用量" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "会话状态" }));
    expect(onOpenStatus).toHaveBeenCalledTimes(1);
  });
});

describe("外部 Harness 选择器", () => {
  const READY_INSPECTION = {
    status: "ready" as const,
    models: [
      {
        id: "claude-sonnet-4-5",
        label: "Sonnet 4.5",
        thinkingOptionIds: ["low", "high"],
      },
      { id: "claude-opus-4-1", label: "Opus 4.1", thinkingOptionIds: [] },
    ],
    defaultModelId: "claude-sonnet-4-5",
    thinkingOptions: [
      { id: "low", label: "低" },
      { id: "high", label: "高" },
    ],
    defaultThinkingOptionId: "low",
    permissionModes: [{ id: "plan", label: "计划" }],
    defaultPermissionModeId: "plan",
    capabilities: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: true,
      permissionModeScope: "live" as const,
    },
  };

  function renderSettings(overrides: Record<string, unknown> = {}) {
    const handlers = {
      onChooseHarness: vi.fn(),
      onChooseHarnessModel: vi.fn(),
      onChooseHarnessThinking: vi.fn(),
      onChooseHarnessPermissionMode: vi.fn(),
      onBackToHarnessList: vi.fn(),
    };
    const view = render(
      <ComposerSettings
        picker="harness"
        effortOptions={[]}
        speedOptions={[]}
        permissionModes={[]}
        models={[]}
        harnessPlugins={[{ id: "hermes", name: "Hermes" }]}
        selectedHarnessId={null}
        selectedHarnessName=""
        harnessInspection={null}
        harnessInspectError=""
        selectedHarnessModelId={null}
        selectedHarnessThinkingId={null}
        selectedHarnessPermissionModeId={null}
        selectedEffort={null}
        selectedModel=""
        selectedModelLabel="默认模型"
        selectedServiceTier={null}
        selectedSpeedLabel="正常"
        selectedPermissionModeId={null}
        onPickerChange={() => undefined}
        onChooseEffort={() => undefined}
        onChooseModel={() => undefined}
        onChooseSpeed={() => undefined}
        onChoosePermissionMode={() => undefined}
        {...handlers}
        {...overrides}
      />,
    );
    return { ...handlers, container: view.container };
  }

  it("未选中时列出可用 harness", () => {
    const { onChooseHarness } = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: /Hermes/ }));

    expect(onChooseHarness).toHaveBeenCalledWith("hermes");
  });

  it("选中后按 capability 渲染模型、思考档位与权限模式", () => {
    renderSettings({
      selectedHarnessId: "hermes",
      selectedHarnessName: "Hermes",
      harnessInspection: READY_INSPECTION,
      selectedHarnessModelId: "claude-sonnet-4-5",
      selectedHarnessThinkingId: "low",
      selectedHarnessPermissionModeId: "plan",
    });

    expect(screen.getByText("Sonnet 4.5")).not.toBeNull();
    expect(screen.getByText("Opus 4.1")).not.toBeNull();
    expect(screen.getByText("低")).not.toBeNull();
    expect(screen.getByText("计划")).not.toBeNull();
  });

  it("capability 关掉的分组不渲染", () => {
    renderSettings({
      selectedHarnessId: "hermes",
      selectedHarnessName: "Hermes",
      harnessInspection: {
        ...READY_INSPECTION,
        capabilities: {
          ...READY_INSPECTION.capabilities,
          selectModel: false,
          selectPermissionMode: false,
        },
      },
    });

    expect(screen.queryByText("Sonnet 4.5")).toBeNull();
    expect(screen.queryByText("计划")).toBeNull();
    // 思考档位仍然可选。
    expect(screen.getByText("低")).not.toBeNull();
  });

  it("harness 不可用时显示上游原文", () => {
    renderSettings({
      selectedHarnessId: "hermes",
      selectedHarnessName: "Hermes",
      harnessInspection: {
        status: "notInstalled" as const,
        errorMessage: "Claude Code CLI not found",
        models: [],
        thinkingOptions: [],
        permissionModes: [],
        capabilities: {
          selectModel: false,
          selectThinkingOption: false,
          selectPermissionMode: false,
          permissionModeScope: "live" as const,
        },
      },
    });

    expect(screen.getByText("Claude Code CLI not found")).not.toBeNull();
  });

  it("官方模型 picker 里不再混入 harness 分组", () => {
    // 曾经把 harness 塞在 model picker 里，而 model/list 根本不含 harness
    // （codex-host 已删除该增强路径），那个分组永远渲染不出来。入口现在独立。
    const route = encodeHarnessRoute({
      harnessId: "hermes",
      model: "claude-sonnet-4-5",
    });
    const view = render(
      <ComposerSettings
        picker="model"
        effortOptions={[]}
        speedOptions={[]}
        permissionModes={[]}
        models={
          [
            { id: "gpt-5", model: "gpt-5-codex", displayName: "GPT-5 Codex" },
            { model: route },
          ] as never
        }
        harnessPlugins={[]}
        selectedHarnessId={null}
        selectedHarnessName=""
        harnessInspection={null}
        harnessInspectError=""
        selectedHarnessModelId={null}
        selectedHarnessThinkingId={null}
        selectedHarnessPermissionModeId={null}
        selectedEffort={null}
        selectedModel=""
        selectedModelLabel="默认模型"
        selectedServiceTier={null}
        selectedSpeedLabel="正常"
        selectedPermissionModeId={null}
        onPickerChange={() => undefined}
        onChooseEffort={() => undefined}
        onChooseModel={() => undefined}
        onChooseSpeed={() => undefined}
        onChoosePermissionMode={() => undefined}
        onChooseHarness={() => undefined}
        onChooseHarnessModel={() => undefined}
        onChooseHarnessThinking={() => undefined}
        onChooseHarnessPermissionMode={() => undefined}
        onBackToHarnessList={() => undefined}
      />,
    );

    expect(
      view.container.querySelectorAll(".popover-options.model-options"),
    ).toHaveLength(1);
    expect(screen.queryByText("外部 Harness")).toBeNull();
  });
});
