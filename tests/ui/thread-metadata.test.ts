import { describe, expect, it, vi } from "vitest";
import {
  activeThreadAfterArchive,
  firstMessageTitle,
  setThreadNameFromFirstMessage,
  setThreadPinned,
} from "../../src/app-server/thread-metadata";

describe("线程元数据", () => {
  it("通过 app-server 持久化置顶状态并返回刷新线程", async () => {
    const thread = { id: "thread-1", isPinned: true };
    const request = vi.fn(async () => ({ thread }));

    await expect(
      setThreadPinned({ request } as any, "thread-1", true),
    ).resolves.toBe(thread);
    expect(request).toHaveBeenCalledWith("thread/metadata/update", {
      threadId: "thread-1",
      isPinned: true,
    });
  });

  it("服务端没有返回目标置顶状态时报告响应异常", async () => {
    const request = vi.fn(async () => ({
      thread: { id: "thread-1" },
    }));

    await expect(
      setThreadPinned({ request } as any, "thread-1", true),
    ).rejects.toThrow("置顶状态不一致");
  });

  it("旧归档响应不会清空后来打开的会话", () => {
    const newerThread = { id: "thread-2", turns: [{ id: "turn-2" }] };

    expect(activeThreadAfterArchive(newerThread, "thread-1")).toBe(
      newerThread,
    );
    expect(activeThreadAfterArchive(newerThread, "thread-2")).toBeNull();
  });

  it("首段文本压成单行标题并按长度截断", () => {
    expect(firstMessageTitle("  帮我   修一下\n这个  bug  ")).toBe(
      "帮我 修一下 这个 bug",
    );

    const title = firstMessageTitle("甲".repeat(200));
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBe(80);
  });

  it("把首段用户消息写成会话名", async () => {
    const request = vi.fn(async () => ({}));

    await expect(
      setThreadNameFromFirstMessage(
        { request } as any,
        "thread-1",
        "  第一条消息  ",
      ),
    ).resolves.toBe("第一条消息");
    expect(request).toHaveBeenCalledWith("thread/name/set", {
      threadId: "thread-1",
      name: "第一条消息",
    });
  });

  it("空白消息不调用 thread/name/set（上游拒绝空串）", async () => {
    const request = vi.fn(async () => ({}));

    await expect(
      setThreadNameFromFirstMessage({ request } as any, "thread-1", "   \n  "),
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
