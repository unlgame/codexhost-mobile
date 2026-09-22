import { createRef, type FormEvent } from "react";
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationPage } from "../../src/features/conversation/ConversationPage";
import type { DraftFile, DraftImage } from "../../src/ui/attachments";

function renderConversation(
  olderTurnsState: "idle" | "loading" | "error" | "exhausted",
  onLoadOlderTurns = vi.fn().mockResolvedValue(true),
  composer: {
    draft?: string;
    busy?: boolean;
    steering?: boolean;
    steerable?: boolean;
    pendingSteerText?: string;
    accessMode?: "interactive" | "readOnly";
    resumeError?: string;
    draftImages?: DraftImage[];
    draftFiles?: DraftFile[];
    onSubmit?: (event: FormEvent) => void;
  } = {},
  onRetry = vi.fn(),
  newChat: {
    projects?: Array<{ cwd: string; name: string }>;
    onProjectChange?: (cwd: string) => void;
    onBackendChange?: (backendId: string) => void;
  } | null = null,
) {
  const onSubmit = composer.onSubmit ?? vi.fn();
  const result = render(
    <ConversationPage
      active={
        newChat
          ? {
              id: "",
              cwd: newChat.projects?.[0]?.cwd ?? "",
              preview: "",
              turns: [],
            }
          : {
              id: "thread-1",
              cwd: "/tmp/project",
              preview: "分页会话",
              turns: [{ id: "turn-10", items: [] }],
            }
      }
      backendId="mini"
      backendName="Mac mini"
      backends={
        newChat
          ? [
              {
                id: "mini",
                name: "Mac mini",
                baseUrl: "http://127.0.0.1:18766",
                token: "t",
                enabled: true,
                order: 0,
              },
            ]
          : []
      }
      projectOptions={newChat?.projects ?? []}
      loadState="ready"
      loadError=""
      olderTurnsState={olderTurnsState}
      connection="online"
      client={null}
      error=""
      draft={composer.draft ?? ""}
      draftImages={composer.draftImages ?? []}
      draftFiles={composer.draftFiles ?? []}
      imageReading={false}
      busy={composer.busy ?? false}
      steering={composer.steering ?? false}
      steerable={composer.steerable ?? true}
      pendingSteerText={composer.pendingSteerText ?? ""}
      accessMode={composer.accessMode ?? "interactive"}
      resumeError={composer.resumeError ?? ""}
      tokenUsage={null}
      usage={null}
      rateLimits={null}
      pendingAction=""
      selectedServiceTier={null}
      selectedModelLabel="Codex"
      selectedEffort={null}
      selectedPermissionLabel="工作区"
      showHarnessChip={false}
      harnessChipLabel=""
      imageInputRef={createRef<HTMLInputElement>()}
      onBack={() => undefined}
      onNewChatBackendChange={newChat?.onBackendChange ?? (() => undefined)}
      onNewChatProjectChange={newChat?.onProjectChange ?? (() => undefined)}
      onPin={async () => true}
      onRename={async () => true}
      onArchive={async () => true}
      onRetry={onRetry}
      onLoadOlderTurns={onLoadOlderTurns}
      onSubmit={onSubmit}
      onRemoveImage={() => undefined}
      onRemoveFile={() => undefined}
      onSelectImages={async () => undefined}
      onOpenAgentSettings={() => undefined}
      onOpenPermissionSettings={() => undefined}
      onOpenHarnessSettings={() => undefined}
      onDraftChange={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  return { ...result, onLoadOlderTurns, onSubmit, onRetry };
}

describe("会话详情历史分页", () => {
  it("用量在 composer 的 chip 排里，不挤在标题栏", () => {
    // codex-host 的口径（renderer-usage-control.ts）：usage 是次要元数据，
    // 坐在 model / permission-mode / agent 三个 trigger 旁边，而不是标题栏的
    // 主操作簇里。
    const { container } = renderConversation("exhausted");
    const view = within(container);
    const group = view.getByRole("group", { name: "会话详情操作" });

    expect(
      within(group).queryByRole("button", { name: "查看用量" }),
    ).toBeNull();
    expect(
      within(group).getByRole("button", { name: "会话操作" }),
    ).not.toBeNull();

    const chips = container.querySelector(".chips");
    expect(chips).not.toBeNull();
    expect(
      within(chips as HTMLElement).getByRole("button", { name: "查看用量" }),
    ).not.toBeNull();
  });

  it("会话操作菜单可以刷新当前会话并自动关闭", () => {
    const onRetry = vi.fn();
    const { container } = renderConversation(
      "exhausted",
      undefined,
      {},
      onRetry,
    );
    const view = within(container);

    fireEvent.click(view.getByRole("button", { name: "会话操作" }));
    fireEvent.click(view.getByRole("button", { name: "刷新会话" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(view.queryByRole("region", { name: "会话操作" })).toBeNull();
  });

  it("用户上滑后不显示悬浮回到底部按钮", () => {
    const { container } = renderConversation("exhausted");
    const scroller = container.querySelector(".conversation-scroll");
    expect(scroller).not.toBeNull();
    Object.defineProperties(scroller!, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });

    fireEvent.scroll(scroller!);

    expect(
      within(container).queryByRole("button", { name: "回到最新消息" }),
    ).toBeNull();
  });

  it("有更早历史时显示入口并只请求一次分页", () => {
    const { container, onLoadOlderTurns } = renderConversation("idle");
    const view = within(container);

    fireEvent.click(view.getByRole("button", { name: "加载更早消息" }));

    expect(onLoadOlderTurns).toHaveBeenCalledOnce();
  });

  it("分页失败时保留详情并显示局部重试", () => {
    const { container } = renderConversation("error");
    const view = within(container);

    expect(view.getByText("加载失败，点击重试")).not.toBeNull();
    expect(view.getByText("分页会话")).not.toBeNull();
  });

  it("其他客户端占用会话时展示只读状态并禁止写入", () => {
    const onRetry = vi.fn();
    const { container } = renderConversation(
      "idle",
      undefined,
      {
        draft: "不能发送",
        accessMode: "readOnly",
        resumeError: "thread already has an active writer",
      },
      onRetry,
    );
    const view = within(container);

    // 只读的成因不止「别的客户端在跑」（外部线程历史无法持久化也会降级到
    // 只读），所以提示语用中性说法，并把上游原文一并显示出来。
    expect(
      view.getByText("当前无法接管该会话，只能查看历史（只读）"),
    ).not.toBeNull();
    expect(view.getByText("thread already has an active writer")).not.toBeNull();
    expect(view.getByLabelText("向 Codex 提问").hasAttribute("disabled")).toBe(
      true,
    );
    expect(view.getByRole("button", { name: "添加附件" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(view.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.click(view.getByRole("button", { name: "重新连接" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("任务执行中输入内容后，停止按钮直接变成引导发送按钮", () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const { container } = renderConversation(
      "exhausted",
      undefined,
      { draft: "先处理测试", busy: true, onSubmit },
    );
    const view = within(container);
    const steer = view.getByRole("button", { name: "引导" });

    expect(steer.getAttribute("type")).toBe("submit");
    expect(view.queryByRole("button", { name: "停止" })).toBeNull();
    fireEvent.click(steer);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("任务执行中没有输入时保留停止按钮，引导提交中显示等待状态", () => {
    const idle = renderConversation(
      "exhausted",
      undefined,
      { busy: true },
    );
    const stop = within(idle.container).getByRole("button", { name: "停止" });
    expect(stop.classList.contains("send-button-running")).toBe(true);
    expect(stop.getAttribute("aria-busy")).toBe("true");
    idle.unmount();

    const pending = renderConversation(
      "exhausted",
      undefined,
      { draft: "继续", busy: true, steering: true },
    );
    const steering = within(pending.container).getByRole("button", {
      name: "正在引导",
    });
    expect(steering.getAttribute("disabled")).not.toBeNull();
  });

  it("空闲已有会话且输入为空时隐藏实时语音入口", () => {
    const { container } = renderConversation("exhausted");
    const view = within(container);

    expect(view.queryByRole("button", { name: "开始实时语音" })).toBeNull();
    expect(view.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("输入文字后仍显示原发送按钮，不改变文字提交", () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const { container } = renderConversation(
      "exhausted",
      undefined,
      { draft: "继续完成测试", onSubmit },
    );
    const view = within(container);

    expect(view.queryByRole("button", { name: "开始实时语音" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "发送" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("引导发送后在输入框上方临时展示单行消息", () => {
    const { container } = renderConversation(
      "exhausted",
      undefined,
      {
        busy: true,
        pendingSteerText:
          "先完成当前检查，再根据测试结果调整实现并重新运行完整测试",
      },
    );
    const view = within(container);
    const preview = view.getByRole("status", { name: "已发送引导" });

    expect(preview.textContent).toBe(
      "先完成当前检查，再根据测试结果调整实现并重新运行完整测试",
    );
    expect(preview.getAttribute("title")).toBe(preview.textContent);
  });

  it("真实 Turn ID 尚未返回时不允许把 pending 回合当作引导目标", () => {
    const { container } = renderConversation(
      "exhausted",
      undefined,
      { draft: "继续", busy: true, steerable: false },
    );
    const view = within(container);

    expect(view.getByRole("button", { name: "停止" })).not.toBeNull();
    expect(view.queryByRole("button", { name: "引导" })).toBeNull();
  });

  it("待发送图片可以打开统一大图预览", () => {
    const { container } = renderConversation(
      "exhausted",
      undefined,
      {
        draftImages: [
          {
            id: "draft-image",
            name: "draft.png",
            type: "image/png",
            size: 68,
            url: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    );
    const view = within(container);

    fireEvent.click(view.getByRole("button", { name: "预览 draft.png" }));

    const preview = within(document.body).getByRole("dialog", {
      name: "图片预览",
    });
    expect(
      within(preview).getByRole("img", { name: "待发送 draft.png" }),
    ).not.toBeNull();
  });

  it("待发送视频可播放，其他文件显示紧凑文件卡片", () => {
    const { container } = renderConversation(
      "exhausted",
      undefined,
      {
        draftFiles: [
          {
            id: "video",
            name: "演示.mp4",
            type: "video/mp4",
            size: 5,
            file: new File(["video"], "演示.mp4", { type: "video/mp4" }),
            previewUrl: "blob:video",
          },
          {
            id: "pdf",
            name: "需求.pdf",
            type: "application/pdf",
            size: 3,
            file: new File(["pdf"], "需求.pdf", { type: "application/pdf" }),
            previewUrl: "blob:pdf",
          },
        ],
      },
    );
    const view = within(container);

    const video = view.getByLabelText("待发送 演示.mp4");
    expect(video.tagName).toBe("VIDEO");
    expect(video.getAttribute("poster")).toMatch(/^data:image\/svg\+xml/);
    expect(view.getByText("PDF")).not.toBeNull();
    expect(view.getByRole("button", { name: "移除 需求.pdf" })).not.toBeNull();
  });
});

describe("新会话的项目 / 机器选择器", () => {
  const projects = [
    { cwd: "/tmp/a", name: "项目 A" },
    { cwd: "/tmp/b", name: "项目 B" },
  ];

  it("项目选择走 App 自己的 sheet，不再用原生 select", () => {
    // 原生 <select> 在 Android WebView 里弹的是系统选择器，样式和 App 完全
    // 脱节——所以这里必须是自己的按钮 + 底部 sheet。
    const onProjectChange = vi.fn();
    const { container } = renderConversation(
      "idle",
      vi.fn().mockResolvedValue(true),
      {},
      vi.fn(),
      { projects, onProjectChange },
    );

    expect(container.querySelector("select")).toBeNull();

    fireEvent.click(
      within(container).getByRole("button", { name: "选择项目" }),
    );
    const sheet = within(container).getByRole("dialog", { name: "选择项目" });
    fireEvent.click(within(sheet).getByText("项目 B"));

    expect(onProjectChange).toHaveBeenCalledWith("/tmp/b");
  });

  it("机器选择走同一套 sheet", () => {
    const onBackendChange = vi.fn();
    const { container } = renderConversation(
      "idle",
      vi.fn().mockResolvedValue(true),
      {},
      vi.fn(),
      { projects, onBackendChange },
    );

    fireEvent.click(
      within(container).getByRole("button", { name: "选择机器" }),
    );
    const sheet = within(container).getByRole("dialog", { name: "选择机器" });
    fireEvent.click(within(sheet).getByText("Mac mini"));

    expect(onBackendChange).toHaveBeenCalledWith("mini");
  });

  it("没有项目时按钮禁用并给出提示", () => {
    const { container } = renderConversation(
      "idle",
      vi.fn().mockResolvedValue(true),
      {},
      vi.fn(),
      { projects: [] },
    );

    const view = within(container);
    expect(
      view.getByRole("button", { name: "选择项目" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      view.getByText("没有可用项目，暂时无法启动新聊天。"),
    ).not.toBeNull();
  });
});
