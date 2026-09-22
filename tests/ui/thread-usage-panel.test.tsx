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

describe("Harness 选择器与跟随它的模型/思考/权限", () => {
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

  const OFFICIAL_MODELS = [
    { id: "gpt-5", model: "gpt-5-codex", displayName: "GPT-5 Codex" },
  ];

  function renderSettings(overrides: Record<string, unknown> = {}) {
    const handlers = {
      onChooseHarness: vi.fn(),
      onChooseHarnessModel: vi.fn(),
      onChooseHarnessThinking: vi.fn(),
      onChooseHarnessPermissionMode: vi.fn(),
      onChooseModel: vi.fn(),
      onChoosePermissionMode: vi.fn(),
    };
    const view = render(
      <ComposerSettings
        picker="harness"
        effortOptions={[{ id: "high", label: "高" }]}
        speedOptions={[]}
        permissionModes={[
          {
            id: ":workspace" as never,
            label: "工作区访问",
            description: "工作区",
            permissions: "",
            approvalPolicy: "never",
            approvalsReviewer: "auto_review",
          },
        ]}
        models={OFFICIAL_MODELS as never}
        harnessPlugins={[{ id: "hermes", name: "Hermes" }]}
        harnessId={null}
        harnessInspection={null}
        harnessInspectError=""
        selectedHarnessModelId={null}
        selectedHarnessThinkingId={null}
        selectedHarnessPermissionModeId={null}
        selectedEffort={null}
        selectedModel="gpt-5-codex"
        selectedModelLabel="GPT-5 Codex"
        selectedServiceTier={null}
        selectedSpeedLabel="正常"
        selectedPermissionModeId={":workspace" as never}
        onPickerChange={() => undefined}
        onChooseEffort={() => undefined}
        onChooseSpeed={() => undefined}
        {...handlers}
        {...overrides}
      />,
    );
    return { ...handlers, container: view.container };
  }

  it("列表里同时有官方 Codex 与外部 harness，选中项打勾", () => {
    renderSettings();

    // 没有 codex 选项就退不回官方，这正是之前那个 bug。
    expect(screen.getByText("官方 Codex")).not.toBeNull();
    expect(screen.getByText("Hermes")).not.toBeNull();

    const official = screen.getByRole("button", { name: /官方 Codex/ });
    expect(official.getAttribute("aria-pressed")).toBe("true");
  });

  it("选官方 Codex 时回调 null，选外部 harness 时回调其 id", () => {
    const { onChooseHarness } = renderSettings();

    fireEvent.click(screen.getByRole("button", { name: /Hermes/ }));
    expect(onChooseHarness).toHaveBeenCalledWith("hermes");

    fireEvent.click(screen.getByRole("button", { name: /官方 Codex/ }));
    expect(onChooseHarness).toHaveBeenLastCalledWith(null);
  });

  it("harness 面板只选 harness，不塞模型/思考/权限", () => {
    // 模型选择统一归中间那个下拉框；这里出现模型就是设计错了。
    renderSettings({
      harnessId: "hermes",
      harnessInspection: READY_INSPECTION,
      selectedHarnessModelId: "claude-sonnet-4-5",
    });

    expect(screen.queryByText("Sonnet 4.5")).toBeNull();
    expect(screen.queryByText("计划")).toBeNull();
    expect(screen.getByText("官方 Codex")).not.toBeNull();
  });

  it("harness 探测失败时在面板里显示上游原文", () => {
    renderSettings({
      harnessId: "hermes",
      harnessInspectError: "Claude Code CLI not found",
    });

    expect(screen.getByText("Claude Code CLI not found")).not.toBeNull();
  });

  it("选中外部 harness 后，模型下拉框换成该 harness 的模型", () => {
    renderSettings({
      picker: "model",
      harnessId: "hermes",
      harnessInspection: READY_INSPECTION,
      selectedHarnessModelId: "claude-opus-4-1",
    });

    // 选中的那个同时出现在标题和列表里，所以用 getAllByText。
    expect(screen.getAllByText("Sonnet 4.5").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Opus 4.1").length).toBeGreaterThan(0);
    // 官方模型不能混进来——它是另一条路。
    expect(screen.queryByText("GPT-5 Codex")).toBeNull();
  });

  it("选中外部 harness 后，智能面板显示它的思考档位", () => {
    renderSettings({
      picker: "agent",
      harnessId: "hermes",
      harnessInspection: READY_INSPECTION,
      selectedHarnessModelId: "claude-sonnet-4-5",
      selectedHarnessThinkingId: "low",
    });

    // sonnet 声明了 supportedThinkingOptionIds，只列它支持的档位。
    expect(screen.getByText("低")).not.toBeNull();
    expect(screen.getByText("高")).not.toBeNull();
    expect(screen.queryByText("速度")).toBeNull();
  });

  it("选中外部 harness 后，权限面板换成它的权限模式", () => {
    renderSettings({
      picker: "permission",
      harnessId: "hermes",
      harnessInspection: READY_INSPECTION,
      selectedHarnessPermissionModeId: "plan",
    });

    expect(screen.getByText("计划")).not.toBeNull();
    expect(screen.queryByText("工作区访问")).toBeNull();
  });

  it("官方 Codex 时三个面板都走原来的官方数据", () => {
    renderSettings({
      picker: "model",
      harnessId: null,
      harnessInspection: READY_INSPECTION,
    });

    // 选中的那个同时出现在标题和列表里，所以用 getAllByText。
    expect(screen.getAllByText("GPT-5 Codex").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sonnet 4.5")).toBeNull();
  });
});
