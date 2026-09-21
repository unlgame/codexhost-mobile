import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatTokenCount,
  formatUsd,
  threadUsageFields,
  threadUsageFromNotification,
} from "../../src/app-server/thread-usage";

describe("formatTokenCount", () => {
  it("覆盖 0 / 999 / 1000 / 1500 / 999999 / 1000000 / 1500000 边界", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(999_999)).toBe("1M");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("保留一位小数并去掉无意义的 .0", () => {
    expect(formatTokenCount(424_100)).toBe("424.1k");
    expect(formatTokenCount(102_400)).toBe("102.4k");
    expect(formatTokenCount(7_600_000)).toBe("7.6M");
    expect(formatTokenCount(8_100_000)).toBe("8.1M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });

  it("四舍五入跨档时向上进位到更大单位", () => {
    expect(formatTokenCount(999_950)).toBe("1M");
    expect(formatTokenCount(1_999_950)).toBe("2M");
    expect(formatTokenCount(999_950_000)).toBe("1B");
    expect(formatTokenCount(999_949)).toBe("999.9k");
  });

  it("缺失或非法值显示占位符", () => {
    expect(formatTokenCount(null)).toBe("—");
    expect(formatTokenCount(undefined)).toBe("—");
    expect(formatTokenCount(Number.NaN)).toBe("—");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatTokenCount(-1500)).toBe("-1.5k");
  });
});

describe("用量金额与百分比", () => {
  it("会话费用固定三位小数", () => {
    expect(formatUsd(0)).toBe("$0.000");
    expect(formatUsd(1.5)).toBe("$1.500");
    expect(formatUsd(0.0004)).toBe("$0.000");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
  });

  it("百分比保留一位并夹在 0-100", () => {
    expect(formatPercent(7.72)).toBe("7.7%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(140)).toBe("100.0%");
    expect(formatPercent(-3)).toBe("0.0%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("threadUsageFields", () => {
  it("映射 thread-usage 契约字段", () => {
    expect(
      threadUsageFields({
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
      }),
    ).toEqual({
      inputTokens: 424_100,
      cachedInputTokens: 7_600_000,
      cacheWriteInputTokens: 0,
      outputTokens: 102_400,
      reasoningOutputTokens: null,
      totalTokens: 8_100_000,
      totalCostUsd: 0,
      totalCredits: null,
      cacheHitRatePercent: null,
      contextUsedTokens: 77_000,
      contextWindowTokens: 1_000_000,
      contextUsagePercent: 7.7,
      planFiveHourUsedPercent: 12,
      planFiveHourResetsAtUnix: null,
      planSevenDayUsedPercent: 34,
      planSevenDayResetsAtUnix: null,
    });
  });

  it("上下文占比优先用 contextUsagePercent", () => {
    expect(
      threadUsageFields({ contextUsagePercent: 42, contextUsedTokens: 1, contextWindowTokens: 2 })
        ?.contextUsagePercent,
    ).toBe(42);
  });

  it("没有任何可靠字段时返回 null", () => {
    expect(threadUsageFields({})).toBeNull();
    expect(threadUsageFields(null)).toBeNull();
    expect(threadUsageFields([])).toBeNull();
    expect(threadUsageFields("nope")).toBeNull();
    expect(threadUsageFields({ inputTokens: "x", totalTokens: null })).toBeNull();
  });

  it("容忍未知字段与非数字值，不崩溃", () => {
    const fields = threadUsageFields({
      inputTokens: 10,
      somethingElse: { nested: true },
      totalTokens: Number.NaN,
    });
    expect(fields?.inputTokens).toBe(10);
    expect(fields?.totalTokens).toBeNull();
  });

  it("通知只带 threadId 时不产出快照", () => {
    expect(threadUsageFromNotification({ threadId: "thread-1" })).toBeNull();
    expect(threadUsageFromNotification(null)).toBeNull();
    expect(
      threadUsageFromNotification({ threadId: "thread-1", usage: { totalTokens: 5 } })
        ?.totalTokens,
    ).toBe(5);
  });
});
