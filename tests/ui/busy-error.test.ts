import { describe, expect, it } from "vitest";
import { BUSY_HINT, busyHintFor, isBusyError } from "../../src/app-server/busy-error";

describe("busy 准入冲突识别", () => {
  it("命中 OfficialAdmissionError 的 busy 文案", () => {
    expect(isBusyError(new Error("Codex is busy"))).toBe(true);
    expect(isBusyError("Codex is busy")).toBe(true);
    expect(isBusyError({ message: "Codex is busy" })).toBe(true);
    expect(busyHintFor(new Error("Codex is busy"))).toBe(BUSY_HINT);
    expect(BUSY_HINT).toBe("另一台设备正在使用，请稍候");
  });

  it("其他错误不误判", () => {
    for (const reason of [
      new Error("Method not found"),
      new Error("Codex is unavailable"),
      new Error(""),
      null,
      undefined,
      42,
      {},
      { message: 7 },
    ]) {
      expect(isBusyError(reason)).toBe(false);
      expect(busyHintFor(reason)).toBeNull();
    }
  });
});
