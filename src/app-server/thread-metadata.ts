import type { AppServerClient } from "./client";
import type { DisplayRecord } from "../ui/app-display";
import { t } from "../i18n";

export async function setThreadPinned(
  client: Pick<AppServerClient, "request">,
  threadId: string,
  isPinned: boolean,
) {
  const result = await client.request<{ thread: DisplayRecord }>(
    "thread/metadata/update",
    { threadId, isPinned },
  );
  if (result.thread?.isPinned !== isPinned) {
    throw new Error(t("服务端返回的置顶状态不一致"));
  }
  return result.thread;
}

export function activeThreadAfterArchive(
  active: DisplayRecord | null,
  archivedThreadId: string,
) {
  return active?.id === archivedThreadId ? null : active;
}

/**
 * 首条用户消息 → 会话标题。
 *
 * 为什么需要它：codex-host 对**外部 harness** 线程在 `thread/list` 里传的是
 * 空 turns（`external-thread-list.ts` 的 `externalThreadValue({ turns: [] })`），
 * 于是 `preview` 恒为空串、`name` 恒为 null；而 `thread/resume` 传的是真实
 * turns，`preview` 就是首条用户消息。同一个 `titleOf()`（name → preview →
 * 「新对话」）因此有两个结果：侧边栏显示「新对话」，标题栏显示首段文本。
 *
 * 让三处一致的唯一办法是把首段文本写进 `name`——codex-host 的
 * `#setExternalThreadName` 会落库并广播 `thread/name/updated`，官方线程由官方
 * runtime 处理，而两侧的取标题口径都是 name → preview。
 */
export function firstMessageTitle(text: string, limit = 80) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * 把首条用户消息写成会话名。返回写进去的名字；空白消息返回 null
 * （上游 `thread/name/set` 拒绝空串并报 -32602）。
 */
export async function setThreadNameFromFirstMessage(
  client: Pick<AppServerClient, "request">,
  threadId: string,
  text: string,
) {
  const name = firstMessageTitle(text);
  if (!name) return null;
  await client.request("thread/name/set", { threadId, name });
  return name;
}
