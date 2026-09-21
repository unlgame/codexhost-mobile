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

describe("model picker 的外部 Harness 分组", () => {
  const route = encodeHarnessRoute({ harnessId: "hermes", model: "claude-sonnet-4-5" });

  function renderPicker(models: unknown[]) {
    const onChooseModel = vi.fn();
    const view = render(
      <ComposerSettings
        picker="model"
        effortOptions={[]}
        speedOptions={[]}
        permissionModes={[]}
        models={models as never}
        harnessPluginNames={{ hermes: "Hermes" }}
        selectedEffort={null}
        selectedModel=""
        selectedModelLabel="默认模型"
        selectedServiceTier={null}
        selectedSpeedLabel="正常"
        selectedPermissionModeId={null}
        onPickerChange={() => undefined}
        onChooseEffort={() => undefined}
        onChooseModel={onChooseModel}
        onChooseSpeed={() => undefined}
        onChoosePermissionMode={() => undefined}
      />,
    );
    return { onChooseModel, container: view.container };
  }

  it("官方模型与外部 Harness 分成两组，互不污染", () => {
    const { container } = renderPicker([
      { id: "gpt-5", model: "gpt-5-codex", displayName: "GPT-5 Codex" },
      { model: route },
    ]);
    const groups = container.querySelectorAll(".popover-options.model-options");
    expect(groups).toHaveLength(2);
    expect(within(groups[0] as HTMLElement).getByText("GPT-5 Codex")).not.toBeNull();
    expect(within(groups[0] as HTMLElement).queryByText("Hermes · claude-sonnet-4-5")).toBeNull();
    expect(screen.getByText("外部 Harness")).not.toBeNull();
    expect(screen.getByText("Hermes · claude-sonnet-4-5")).not.toBeNull();
  });

  it("没有 harness 条目时不渲染分组", () => {
    const { container } = renderPicker([
      { id: "gpt-5", model: "gpt-5-codex", displayName: "GPT-5 Codex" },
    ]);
    expect(container.querySelectorAll(".popover-options.model-options")).toHaveLength(1);
    expect(screen.queryByText("外部 Harness")).toBeNull();
  });

  it("选中 harness 后原样透传 model ref", () => {
    const { onChooseModel } = renderPicker([{ model: route }]);
    fireEvent.click(screen.getByRole("button", { name: /Hermes · claude-sonnet-4-5/ }));
    expect(onChooseModel).toHaveBeenCalledWith(route);
  });
});
