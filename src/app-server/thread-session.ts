import type {
  ApprovalPolicy,
  ApprovalsReviewer,
} from "../ui/settings";

type AnyRecord = Record<string, any>;
const initialTurnsLimit = 10;

interface Requester {
  request(method: string, params: unknown): Promise<any>;
}

export interface ResumedThreadSession {
  thread: AnyRecord;
  accessMode: ThreadAccessMode;
  resumeError?: string;
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  activePermissionProfile?: { id: string } | null;
  settingsSynchronized: boolean;
  nextTurnsCursor: string | null;
}

export type ThreadAccessMode = "interactive" | "readOnly";

export interface ThreadTurnsPage {
  turns: AnyRecord[];
  nextCursor: string | null;
}

export type OlderTurnsLoadState =
  | "idle"
  | "loading"
  | "error"
  | "exhausted";

function chronologicalTurns(data: AnyRecord[] | undefined) {
  return [...(data ?? [])].reverse();
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

// resume 失败一律先尝试只读降级，而不是只认某一个错误子串。
//
// 上游拒绝 thread/resume 的理由不止「已有活跃写入者」一种。外部 harness 线程
// 在别处（比如桌面端）被延续过之后，codex-host 会在 refresh 阶段撞上
// alignSnapshot 的身份校验失败，并以 -32081 统一报成
// "External Thread history could not be persisted"——refresh() 把该分支所有
// 异常压成同一句话，所以光看文案分不出是哪种。
//
// 原来只匹配 "already has an active writer"，于是这类线程连只读历史都打不开，
// 界面只剩「无法加载会话」加一句英文原文。
//
// 只读路径（thread/read includeTurns:false + thread/turns/list）在 codex-host
// 侧走 resolve → #restore，对齐的是仓库里最新读出的 record，不经过会失败的
// refresh，所以能拿到历史。只读也失败时再抛原始错误——「线程真的不存在」
// 「连接断了」这类失败不该被伪装成只读成功。

export function prependUniqueTurns(
  current: AnyRecord[],
  older: AnyRecord[],
) {
  const currentIds = new Set(current.map((turn) => String(turn.id)));
  return [
    ...older.filter((turn) => !currentIds.has(String(turn.id))),
    ...current,
  ];
}

export async function loadOlderThreadTurns(
  client: Requester,
  threadId: string,
  cursor: string,
): Promise<ThreadTurnsPage> {
  const response = await client.request("thread/turns/list", {
    threadId,
    cursor,
    limit: initialTurnsLimit,
    sortDirection: "desc",
    itemsView: "full",
  });
  return {
    turns: chronologicalTurns(response.data),
    nextCursor: response.nextCursor ?? null,
  };
}

export async function loadRecentThreadTurns(
  client: Requester,
  threadId: string,
): Promise<AnyRecord[]> {
  const response = await client.request("thread/turns/list", {
    threadId,
    limit: initialTurnsLimit,
    sortDirection: "desc",
    itemsView: "full",
  });
  return chronologicalTurns(response.data);
}

export async function loadStableRecentThreadTurns(
  client: Requester,
  threadId: string,
  readNotificationSequence: () => number,
  maxAttempts = 3,
): Promise<AnyRecord[] | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const sequence = readNotificationSequence();
    const turns = await loadRecentThreadTurns(client, threadId);
    if (sequence === readNotificationSequence()) return turns;
  }
  return null;
}

export async function loadRecoverableRecentThreadTurns(
  client: Requester,
  threadId: string,
  readNotificationSequence: () => number,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
  maxAttempts = 3,
): Promise<AnyRecord[] | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const turns = await loadStableRecentThreadTurns(
        client,
        threadId,
        readNotificationSequence,
      );
      if (turns != null) return turns;
    } catch {
      // 快照读取失败不代表 WebSocket 已断开；先在当前连接上限次重试。
    }
    if (attempt < maxAttempts - 1) {
      await wait(300 * 2 ** attempt);
    }
  }
  return null;
}

export async function resumeThreadSession(
  client: Requester,
  threadId: string,
): Promise<ResumedThreadSession> {
  try {
    const response = await client.request("thread/resume", {
      threadId,
      excludeTurns: true,
      initialTurnsPage: {
        limit: initialTurnsLimit,
        sortDirection: "desc",
        itemsView: "full",
      },
    });
    const initialTurnsPage = response.initialTurnsPage;
    return {
      thread: {
        ...response.thread,
        turns: initialTurnsPage?.data
          ? chronologicalTurns(initialTurnsPage.data)
          : response.thread.turns ?? [],
      },
      model: response.model,
      reasoningEffort: response.reasoningEffort,
      serviceTier: response.serviceTier,
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer,
      activePermissionProfile: response.activePermissionProfile,
      accessMode: "interactive",
      settingsSynchronized: true,
      nextTurnsCursor: initialTurnsPage?.nextCursor ?? null,
    };
  } catch (reason) {
    const resumeError = errorMessage(reason);
    try {
      const response = await client.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      const turnsPage = await client.request("thread/turns/list", {
        threadId,
        limit: initialTurnsLimit,
        sortDirection: "desc",
        itemsView: "full",
      });
      return {
        thread: {
          ...response.thread,
          turns: chronologicalTurns(turnsPage.data),
        },
        accessMode: "readOnly",
        resumeError,
        settingsSynchronized: false,
        nextTurnsCursor: turnsPage.nextCursor ?? null,
      };
    } catch {
      // 只读也拿不到，说明不是「被别处占用」而是更根本的失败
      // （线程不存在、连接已断等）。保留原始 resume 原因，别让只读的
      // 失败把它盖掉。
      throw reason;
    }
  }
}
