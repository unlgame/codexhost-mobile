import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppServerClient, type RpcMessage } from "./app-server/client";
import {
  createLatestThreadListLoader,
  type ProjectThreadLoadState,
} from "./app-server/thread-list-loader";
import {
  applyCompletedTurn,
  applyFileChangePatch,
  applyTurnDiff,
  applyTurnItem,
  applyTurnStarted,
  createPendingTurn,
  isThreadRunning,
  reconcileRecentTurns,
  removePendingTurn,
} from "./ui/conversation";
import {
  loadRecoverableRecentThreadTurns,
  loadOlderThreadTurns,
  prependUniqueTurns,
  resumeThreadSession,
  type OlderTurnsLoadState,
  type ThreadAccessMode,
} from "./app-server/thread-session";
import {
  activeTurnId,
  buildTurnSteerParams,
  clearPendingSteerForItem,
  clearPendingSteerForRequest,
  clearPendingSteerForThread,
  clearPendingSteerForTimeline,
  mergeSteerDraft,
  type PendingSteerMessage,
} from "./app-server/turn-steering";
import {
  activeThreadAfterArchive,
  firstMessageTitle,
  setThreadNameFromFirstMessage,
  setThreadPinned,
} from "./app-server/thread-metadata";
import {
  ConversationPage,
  type ConversationLoadState,
} from "./features/conversation/ConversationPage";
import { ThreadListPage } from "./features/threads/ThreadListPage";
import { ApprovalSheet } from "./features/approvals/ApprovalSheet";
import {
  ComposerSettings,
  type ComposerPicker,
} from "./features/settings/ComposerSettings";
import {
  AppIcon,
  titleOf,
  type ConnectionState,
  type ThreadListState,
} from "./ui/app-display";
import {
  ImageReadGeneration,
  buildOptimisticUserContent,
  buildTurnInput,
  mergeDraftImages,
  prepareImageFiles,
  prepareAttachmentFiles,
  isNativeImageFile,
  type DraftImage,
  type DraftFile,
} from "./ui/attachments";
import { uploadFile } from "./backends/file-upload";
import {
  effortOptionsForModel,
  defaultNewChatPermissionMode,
  normalizeModelSettings,
  permissionModeFromSettings,
  permissionModesFromProfiles,
  permissionProfileLabel,
  speedOptionsForModel,
  type ApprovalPolicy,
  type ApprovalsReviewer,
  type PermissionMode,
  type PermissionModeId,
} from "./ui/settings";
import {
  assignBackendHostId,
  loadBackendRegistry,
  saveBackendRegistry,
} from "./backends/registry";
import { BackendConnectionManager } from "./backends/connection-manager";
import {
  bindConnectionRecovery,
  bindReadOnlyThreadRefresh,
  reconnectAndWaitUntilReady,
  recoverBackendConnection,
} from "./backends/connection-recovery";
import { fetchBackendHostInfo, fetchBackendProjects } from "./backends/probe";
import type {
  BackendConfig,
  BackendRegistry,
  BackendRuntimeSummary,
} from "./backends/types";
import { BackendManagerSheet } from "./features/backends/BackendManagerSheet";
import { BackendAttentionBanner } from "./features/backends/BackendAttentionBanner";
import { AppUpdateSheet } from "./features/update/AppUpdateSheet";
import {
  useAppUpdate,
  type AppUpdateController,
} from "./features/update/useAppUpdate";
import {
  aggregateThreads,
  filterAggregatedThreads,
  type AggregatedThreadItem,
} from "./features/threads/thread-list-model";
import {
  projectCollapseKey,
  readCollapsedProjectKeys,
  writeCollapsedProjectKeys,
} from "./features/threads/project-collapse";
import { useSidebarRefresh } from "./features/threads/sidebar-refresh";
import {
  readUnreadThreadIds,
  shouldMarkThreadUnread,
  writeUnreadThreadIds,
} from "./features/threads/thread-unread";
import { busyHintFor } from "./app-server/busy-error";
import {
  harnessPluginName,
  loadHarnessPlugins,
} from "./app-server/harness-models";
import { tryEncodeHarnessRoute } from "./app-server/harness-route";
import {
  THREAD_INSPECT_METHOD,
  inspectHarness,
  selectThreadModel,
  selectThreadPermissionMode,
  selectThreadThinking,
  threadHarnessBinding,
  type HarnessInspection,
} from "./app-server/harness-inspect";
import type { HarnessPluginOption } from "./features/settings/HarnessPicker";
import {
  CODEXHOST_THREAD_USAGE_UPDATED_METHOD,
  inspectThreadUsage,
  threadUsageFromNotification,
  type ThreadUsageFields,
} from "./app-server/thread-usage";
import { t, useI18n } from "./i18n";

type AnyRecord = Record<string, any>;

interface BackendThreadSnapshot {
  backendId: string;
  threads: AnyRecord[];
  projects: string[];
  projectThreadStates: Record<string, ProjectThreadLoadState>;
  loadingProjectCwd: string;
  refreshing: boolean;
  threadListState: ThreadListState;
  openingThreadId: string;
  error: string;
}

interface WorkspaceCommand {
  id: number;
  backendId: string;
  type: "new" | "open" | "load-project" | "retry-project";
  thread?: AnyRecord;
  cwd?: string | null;
  draft?: string;
  draftImages?: DraftImage[];
  draftFiles?: DraftFile[];
}

interface BackendWorkspaceProps {
  backend: BackendConfig;
  conversationVisible: boolean;
  backends: BackendConfig[];
  summaries: Record<string, BackendRuntimeSummary>;
  onSummaryChange: (summary: BackendRuntimeSummary) => void;
  onSnapshotChange: (snapshot: BackendThreadSnapshot) => void;
  onOpenSidebar: () => void;
  onSwitchNewChatBackend: (
    backendId: string,
    draft: string,
    draftImages: DraftImage[],
    draftFiles: DraftFile[],
  ) => void;
  command: WorkspaceCommand | null;
  refreshVersion: number;
}

function BackendWorkspace({
  backend,
  conversationVisible,
  backends,
  summaries,
  onSummaryChange,
  onSnapshotChange,
  onOpenSidebar,
  onSwitchNewChatBackend,
  command,
  refreshVersion,
}: BackendWorkspaceProps) {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [threads, setThreads] = useState<AnyRecord[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [projectThreadStates, setProjectThreadStates] = useState<
    Record<string, ProjectThreadLoadState>
  >({});
  const [loadingProjectCwd, setLoadingProjectCwd] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [threadListState, setThreadListState] =
    useState<ThreadListState>("loading");
  const [active, setActive] = useState<AnyRecord | null>(null);
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [draftFiles, setDraftFiles] = useState<DraftFile[]>([]);
  const [imageReading, setImageReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startingThreadContext, setStartingThreadContext] = useState<
    number | null
  >(null);
  const [steering, setSteering] = useState(false);
  const [pendingSteerMessage, setPendingSteerMessage] =
    useState<PendingSteerMessage | null>(null);
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<RpcMessage[]>([]);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});
  const [models, setModels] = useState<AnyRecord[]>([]);
  const [permissionProfiles, setPermissionProfiles] = useState<AnyRecord[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
  const [selectedServiceTier, setSelectedServiceTier] = useState<string | null>(null);
  const [selectedPermission, setSelectedPermission] = useState("");
  const [selectedApprovalPolicy, setSelectedApprovalPolicy] =
    useState<ApprovalPolicy>("on-request");
  const [selectedApprovalsReviewer, setSelectedApprovalsReviewer] =
    useState<ApprovalsReviewer>("user");
  const [newChatPermissionMode, setNewChatPermissionMode] =
    useState<PermissionMode | null>(null);
  const [activeSettingsSynchronized, setActiveSettingsSynchronized] =
    useState(true);
  const [activeThreadAccessMode, setActiveThreadAccessMode] =
    useState<ThreadAccessMode>("interactive");
  const [activeThreadResumeError, setActiveThreadResumeError] = useState("");
  const [openingThreadId, setOpeningThreadId] = useState("");
  const [conversationLoadState, setConversationLoadState] =
    useState<ConversationLoadState>("idle");
  const [conversationLoadError, setConversationLoadError] = useState("");
  const [olderTurnsState, setOlderTurnsState] =
    useState<OlderTurnsLoadState>("exhausted");
  const [tokenUsageByThread, setTokenUsageByThread] = useState<
    Record<string, AnyRecord>
  >({});
  const [rateLimits, setRateLimits] = useState<AnyRecord | null>(null);
  const [threadUsageByThread, setThreadUsageByThread] = useState<
    Record<string, ThreadUsageFields>
  >({});
  const [harnessPlugins, setHarnessPlugins] = useState<HarnessPluginOption[]>([]);
  const [selectedHarnessId, setSelectedHarnessId] = useState<string | null>(null);
  const [harnessInspection, setHarnessInspection] =
    useState<HarnessInspection | null>(null);
  const [harnessInspectError, setHarnessInspectError] = useState("");
  const [selectedHarnessModelId, setSelectedHarnessModelId] = useState<
    string | null
  >(null);
  const [selectedHarnessThinkingId, setSelectedHarnessThinkingId] = useState<
    string | null
  >(null);
  const [selectedHarnessPermissionModeId, setSelectedHarnessPermissionModeId] =
    useState<string | null>(null);
  /**
   * 当前线程绑定的 harness。harness 只在 `thread/start` 时绑定，会话中换不了，
   * 所以这个值既用于显示，也用于决定 `turn/start` 要不要带 `model`
   * （带错会被上游以 -32602 拒绝）。
   */
  const [activeHarnessId, setActiveHarnessId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [notice, setNotice] = useState("");
  const [picker, setPicker] = useState<ComposerPicker>(null);
  const clientRef = useRef<AppServerClient | null>(null);
  const connectionManagerRef = useRef<BackendConnectionManager | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imageReadGenerationRef = useRef(new ImageReadGeneration());
  const draftContextGenerationRef = useRef(0);
  const activeRef = useRef<AnyRecord | null>(null);
  const conversationVisibleRef = useRef(conversationVisible);
  const activeThreadTargetRef = useRef<string | null>(null);
  const openSequenceRef = useRef(0);
  const olderTurnsCursorRef = useRef<string | null>(null);
  const olderTurnsGenerationRef = useRef(0);
  const olderTurnsLoadingRef = useRef(false);
  const fullyLoadedProjectCwdsRef = useRef(new Set<string>());
  const refreshSequenceRef = useRef(0);
  const threadNotificationSequenceRef = useRef(0);
  const pendingSequenceRef = useRef(0);
  const readLocalUnread = () =>
    readUnreadThreadIds(localStorage, backend.id);
  const writeLocalUnread = (ids: Set<string>) => {
    writeUnreadThreadIds(localStorage, backend.id, ids);
  };
  const markThreadRead = (threadId: string) => {
    const unread = readLocalUnread();
    if (!unread.delete(threadId)) return;
    writeLocalUnread(unread);
    setThreads((current) =>
      current.map((thread) =>
        String(thread.id) === threadId
          ? { ...thread, isUnread: false }
          : thread,
      ),
    );
  };
  const markThreadUnread = (threadId: string) => {
    const unread = readLocalUnread();
    unread.add(threadId);
    writeLocalUnread(unread);
    setThreads((current) =>
      current.map((thread) =>
        String(thread.id) === threadId
          ? { ...thread, isUnread: true }
          : thread,
      ),
    );
  };
  const threadListLoaderRef = useRef<ReturnType<
    typeof createLatestThreadListLoader
  > | null>(null);
  if (!threadListLoaderRef.current) {
    const decorateThreads = (data: AnyRecord[]): AnyRecord[] => {
      const localUnread = readLocalUnread();
      return data.map((thread) => ({
        ...thread,
        isPinned: thread.isPinned === true,
        isUnread: localUnread.has(String(thread.id)),
      }));
    };
    threadListLoaderRef.current = createLatestThreadListLoader({
      onData(data) {
        setThreads(decorateThreads(data));
        setThreadListState("ready");
      },
      onProjectStart(cwd) {
        setProjectThreadStates((current) => ({
          ...current,
          [cwd]: "loading",
        }));
      },
      onProjectData(cwd, data) {
        const nextProjectThreads = decorateThreads(data);
        setThreads((current) => {
          const currentProjectThreads = current.filter(
            (thread) => thread.cwd === cwd,
          );
          const retainedExpandedThreads =
            fullyLoadedProjectCwdsRef.current.has(cwd)
              ? currentProjectThreads.filter(
                  (thread) =>
                    !nextProjectThreads.some(
                      (next) => String(next.id) === String(thread.id),
                    ),
                )
              : [];
          return [
            ...current.filter((thread) => thread.cwd !== cwd),
            ...nextProjectThreads,
            ...retainedExpandedThreads,
          ];
        });
        setProjectThreadStates((current) => ({
          ...current,
          [cwd]: "ready",
        }));
        setThreadListState("ready");
      },
      onProjectError(cwd) {
        setProjectThreadStates((current) => ({
          ...current,
          [cwd]: "error",
        }));
      },
      onSettled() {
        setThreadListState("ready");
      },
    });
  }

  useEffect(() => {
    activeRef.current = active;
    setPendingSteerMessage((current) =>
      clearPendingSteerForTimeline(current, active),
    );
  }, [active]);

  useEffect(() => {
    conversationVisibleRef.current = conversationVisible;
  }, [conversationVisible]);

  async function loadThreads(client = clientRef.current) {
    if (!client || client !== clientRef.current) return;
    try {
      let directories: string[] = [];
      try {
        directories = await fetchBackendProjects(backend);
        setProjects(directories);
        if (directories.length) setThreadListState("ready");
      } catch {
        directories = projects;
        if (directories.length) setThreadListState("ready");
      }
      await threadListLoaderRef.current!.load(client, directories);
    } catch (reason) {
      setThreadListState((current) =>
        current === "loading" ? "error" : current,
      );
      throw reason;
    }
  }

  async function reconcileActiveThread(
    client: AppServerClient,
    isCurrent: () => boolean = () => true,
  ) {
    const threadId = String(
      activeThreadTargetRef.current ?? activeRef.current?.id ?? "",
    );
    if (!threadId || client !== clientRef.current) return;
    const discardPendingThrough = pendingSequenceRef.current;

    const latestTurns = await loadRecoverableRecentThreadTurns(
      client,
      threadId,
      () => threadNotificationSequenceRef.current,
    );
    if (
      client !== clientRef.current ||
      String(
        activeThreadTargetRef.current ?? activeRef.current?.id ?? "",
      ) !== threadId ||
      activeRef.current?.id !== threadId ||
      latestTurns == null ||
      !isCurrent()
    ) {
      return;
    }

    const lastTurn = latestTurns.at(-1);
    const running =
      ["inProgress", "in_progress", "running"].includes(
        String(lastTurn?.status ?? ""),
      ) || pendingSequenceRef.current > discardPendingThrough;
    setActive((current) =>
      current?.id === threadId
        ? {
            ...current,
            turns: reconcileRecentTurns(current.turns ?? [], latestTurns, {
              discardPendingThrough,
            }),
          }
        : current,
    );
    setBusy(running);
    setThreads((entries) =>
      entries.map((entry) =>
        entry.id === threadId
          ? {
              ...entry,
              status: { type: running ? "active" : "idle" },
            }
          : entry,
      ),
    );
  }

  useEffect(() => {
    if (
      activeThreadAccessMode !== "readOnly" ||
      !active?.id ||
      !conversationVisible ||
      conversationLoadState !== "ready"
    ) return;
    return bindReadOnlyThreadRefresh({
      refresh: async (isCurrent) => {
        const client = clientRef.current;
        if (client) await reconcileActiveThread(client, isCurrent);
      },
    });
  }, [
    active?.id,
    activeThreadAccessMode,
    conversationLoadState,
    conversationVisible,
  ]);

  useEffect(() => {
    const hasRunningThread = threads.some((thread) =>
      isThreadRunning(thread.status),
    );
    onSummaryChange({
      backendId: backend.id,
      connection,
      busy: busy || hasRunningThread,
      approvalCount: requests.length,
      error,
    });
  }, [
    backend.id,
    busy,
    connection,
    error,
    onSummaryChange,
    requests.length,
    threads,
  ]);

  useEffect(() => {
    onSnapshotChange({
      backendId: backend.id,
      threads,
      projects,
      projectThreadStates,
      loadingProjectCwd,
      refreshing,
      threadListState,
      openingThreadId,
      error,
    });
  }, [
    backend.id,
    error,
    onSnapshotChange,
    openingThreadId,
    threadListState,
    threads,
    projects,
    projectThreadStates,
    loadingProjectCwd,
    refreshing,
  ]);

  useEffect(() => {
    if (!refreshVersion) return;
    const sequence = ++refreshSequenceRef.current;
    fullyLoadedProjectCwdsRef.current.clear();
    setThreadListState((current) => (projects.length ? current : "loading"));
    setRefreshing(true);
    if (!clientRef.current) {
      connectionManagerRef.current?.reconnect(backend.id);
      return;
    }
    void loadThreads()
      .catch(() => undefined)
      .finally(() => {
        if (sequence === refreshSequenceRef.current) setRefreshing(false);
      });
  }, [refreshVersion]);

  useEffect(() => {
    let disposed = false;
    let manager: BackendConnectionManager;
    manager = new BackendConnectionManager({
      onConnection: (_backendId, status, connectionError) => {
        if (disposed) return;
        setConnection(status);
        if (status === "online") setError("");
        if (connectionError) setError(connectionError);
        if (status === "connecting") {
          clientRef.current = null;
        }
        if (status === "offline") {
          clientRef.current = null;
          setRefreshing(false);
          setBusy(false);
          setSteering(false);
          setPendingSteerMessage(null);
          setRequests([]);
          void fetchBackendHostInfo(backend).catch((reason) => {
            const message =
              reason instanceof Error ? reason.message : String(reason);
            if (
              message.includes(t("访问口令不正确")) ||
              message.includes(t("当前前端地址未被设备允许"))
            ) {
              manager.sync([]);
              setError(message);
            }
          });
        }
      },
      onNotification: (_backendId, message, source) => {
          const client = source as AppServerClient;
          const params = (message.params ?? {}) as AnyRecord;
          if (
            params.threadId &&
            params.threadId ===
              (activeThreadTargetRef.current ?? activeRef.current?.id)
          ) {
            threadNotificationSequenceRef.current += 1;
          }
          // 列表级通知。之前一个都没处理，于是别处（桌面端）新建、改名、归档的
          // 会话都不会反映到手机上，只能靠手动刷新或下一次 turn/completed 顺带
          // 重载。小桥在没有订阅者时是广播的，所以这些帧本来就会到手机，只是
          // 被丢掉了。
          if (message.method === "thread/started" && params.thread) {
            const started = params.thread as AnyRecord;
            if (typeof started.id === "string") {
              setThreads((current) =>
                current.some((entry) => entry.id === started.id)
                  ? current
                  : [started, ...current],
              );
            }
          }
          if (message.method === "thread/name/updated" && params.threadId) {
            // threadName 允许为 null（清空名字），此时退回 preview 兜底。
            const name =
              typeof params.threadName === "string" ? params.threadName : "";
            setThreads((current) =>
              current.map((entry) =>
                entry.id === params.threadId ? { ...entry, name } : entry,
              ),
            );
            setActive((current) =>
              current && current.id === params.threadId
                ? { ...current, name }
                : current,
            );
          }
          if (
            (message.method === "thread/archived" ||
              message.method === "thread/deleted") &&
            params.threadId
          ) {
            setThreads((current) =>
              current.filter((entry) => entry.id !== params.threadId),
            );
            setActive((current) =>
              activeThreadAfterArchive(current, params.threadId),
            );
          }
          if (message.method === "thread/unarchived" && params.threadId) {
            // 取消归档会把线程重新放回列表，重拉一次比本地拼一条更稳。
            void loadThreads(client).catch(() => undefined);
          }
          if (message.method === "turn/started" && params.turn) {
            if (params.threadId) {
              setThreads((current) => {
                const index = current.findIndex(
                  (thread) => thread.id === params.threadId,
                );
                if (index >= 0) {
                  return current.map((thread, threadIndex) =>
                    threadIndex === index
                      ? { ...thread, status: { type: "active" } }
                      : thread,
                  );
                }
                const opened = activeRef.current;
                return opened?.id === params.threadId
                  ? [{ ...opened, status: { type: "active" } }, ...current]
                  : current;
              });
            }
            setActive((current) => {
              if (!current) return current;
              const started = applyTurnStarted(current, params);
              if (started !== current) setBusy(true);
              return started;
            });
          }
          if (
            message.method === "thread/tokenUsage/updated" &&
            params.threadId &&
            params.tokenUsage
          ) {
            setTokenUsageByThread((current) => ({
              ...current,
              [params.threadId]: params.tokenUsage,
            }));
          }
          if (message.method === CODEXHOST_THREAD_USAGE_UPDATED_METHOD) {
            // codex-host 只广播 { threadId } 作为变更信号；快照回读 inspect。
            const inline = threadUsageFromNotification(params);
            const threadId = String(params.threadId ?? "");
            if (inline) {
              setThreadUsageByThread((current) => ({
                ...current,
                [threadId]: inline,
              }));
            } else if (threadId) {
              void inspectThreadUsage(client, threadId).then((usage) => {
                if (usage) {
                  setThreadUsageByThread((current) => ({
                    ...current,
                    [threadId]: usage,
                  }));
                }
              });
            }
          }
          if (
            message.method === "account/rateLimits/updated" &&
            params.rateLimits
          ) {
            setRateLimits((current) => ({
              ...(current ?? {}),
              rateLimits: {
                ...(current?.rateLimits ?? {}),
                ...params.rateLimits,
              },
            }));
          }
          if (message.method === "item/agentMessage/delta" && params.delta) {
            setActive((current) => {
              if (!current || current.id !== params.threadId) return current;
              const copy = structuredClone(current);
              const turn = copy.turns?.find(
                (entry: AnyRecord) => entry.id === params.turnId,
              );
              const item = turn?.items?.find((entry: AnyRecord) => entry.id === params.itemId);
              if (!item) return current;
              if (item) item.text = `${item.text ?? ""}${params.delta}`;
              return copy;
            });
          }
          if (message.method === "item/started" && params.item) {
            setPendingSteerMessage((current) =>
              clearPendingSteerForItem(current, params),
            );
            setActive((current) =>
              current ? applyTurnItem(current, params) : current,
            );
          }
          if (message.method === "item/completed" && params.item) {
            setPendingSteerMessage((current) =>
              clearPendingSteerForItem(current, params),
            );
            setActive((current) =>
              current ? applyTurnItem(current, params) : current,
            );
          }
          if (
            message.method === "item/commandExecution/outputDelta" ||
            message.method === "item/fileChange/outputDelta" ||
            message.method === "item/reasoning/summaryTextDelta" ||
            message.method === "item/reasoning/textDelta"
          ) {
            const streamMethod = message.method ?? "";
            setActive((current) => {
              if (!current || current.id !== params.threadId) return current;
              const copy = structuredClone(current);
              const turn = copy.turns?.find(
                (entry: AnyRecord) => entry.id === params.turnId,
              );
              const item = turn?.items?.find((entry: AnyRecord) => entry.id === params.itemId);
              if (!item) return current;
              if (item) {
                const key = streamMethod.includes("commandExecution") || streamMethod.includes("fileChange")
                  ? "aggregatedOutput"
                  : "text";
                item[key] = `${item[key] ?? ""}${params.delta ?? ""}`;
              }
              return copy;
            });
          }
          if (message.method === "item/fileChange/patchUpdated") {
            setActive((current) =>
              current ? applyFileChangePatch(current, params) : current,
            );
          }
          if (message.method === "turn/diff/updated") {
            setActive((current) =>
              current ? applyTurnDiff(current, params) : current,
            );
          }
          if (message.method === "turn/completed") {
            if (params.threadId) {
              const threadId = String(params.threadId);
              setPendingSteerMessage((current) =>
                clearPendingSteerForThread(current, threadId),
              );
              if (
                shouldMarkThreadUnread({
                  threadId,
                  activeThreadId: String(activeRef.current?.id ?? ""),
                  conversationVisible: conversationVisibleRef.current,
                  documentVisible:
                    document.visibilityState === "visible",
                })
              ) {
                markThreadUnread(threadId);
              } else {
                markThreadRead(threadId);
              }
              setThreads((current) =>
                current.map((thread) =>
                  String(thread.id) === threadId
                    ? { ...thread, status: { type: "idle" } }
                    : thread,
                ),
              );
            }
            setActive((current) => {
              if (!current) return current;
              const completed = applyCompletedTurn(current, params);
              if (completed === current) return current;
              setBusy(false);
              setSteering(false);
              return completed;
            });
            void loadThreads(client);
          }
          if (
            message.method === "thread/status/changed" &&
            params.threadId &&
            params.status
          ) {
            setThreads((current) =>
              current.map((thread) =>
                thread.id === params.threadId
                  ? { ...thread, status: params.status }
                  : thread,
              ),
            );
          }
          if (
            message.method === "thread/settings/updated" &&
            activeRef.current?.id === params.threadId
          ) {
            const settings = (params.threadSettings ?? {}) as AnyRecord;
            if (typeof settings.model === "string") setSelectedModel(settings.model);
            if ("effort" in settings) {
              setSelectedEffort(settings.effort ?? null);
            }
            if ("serviceTier" in settings) {
              setSelectedServiceTier(settings.serviceTier ?? null);
            }
            if (settings.approvalPolicy) {
              setSelectedApprovalPolicy(settings.approvalPolicy as ApprovalPolicy);
            }
            if (settings.approvalsReviewer) {
              setSelectedApprovalsReviewer(
                settings.approvalsReviewer as ApprovalsReviewer,
              );
            }
            if ("activePermissionProfile" in settings) {
              setSelectedPermission(settings.activePermissionProfile?.id ?? "");
            }
            setActiveSettingsSynchronized(true);
          }
      },
      onRequest: (_backendId, request, source) => {
          const client = source as AppServerClient;
          if (
            request.method === "item/commandExecution/requestApproval" ||
            request.method === "item/fileChange/requestApproval" ||
            request.method === "item/permissions/requestApproval" ||
            request.method === "item/tool/requestUserInput"
          ) {
            setRequests((current) => [...current, request]);
          } else {
            client.respondError(
              request.id!,
              -32601,
              t("Codex Mobile Web 暂不支持服务器请求：{method}", {
                method: request.method ?? "unknown",
              }),
            );
          }
      },
      onReady: (_backendId, source) => {
        const client = source as AppServerClient;
        clientRef.current = client;
        void (async () => {
          try {
            if (!disposed && manager.client(backend.id) === source) {
            const [
              modelResult,
              permissionResult,
              configResult,
              rateLimitResult,
            ] = await Promise.all([
              client.request<{ data: AnyRecord[] }>("model/list", {
                limit: 100,
                includeHidden: false,
              }),
              client.request<{ data: AnyRecord[] }>("permissionProfile/list", {
                limit: 100,
                cwd: null,
              }),
              client
                .request<{ config: AnyRecord }>("config/read", {
                  cwd: null,
                  includeLayers: false,
                })
                .catch(() => ({ config: {} })),
              client
                .request<AnyRecord>("account/rateLimits/read", undefined)
                .catch(() => null),
            ]);
            if (disposed || manager.client(backend.id) !== source) return;
            const availableProfiles = permissionResult.data.filter(
              (profile) => profile.allowed,
            );
            const config = (configResult.config ?? {}) as AnyRecord;
            const configuredModel =
              config.model ||
              modelResult.data.find((model) => model.isDefault)?.model ||
              modelResult.data[0]?.model ||
              "";
            const configuredCatalog = modelResult.data.find(
              (model) => model.model === configuredModel,
            );
            const normalized = normalizeModelSettings(
              configuredCatalog,
              config.model_reasoning_effort,
              config.service_tier,
            );
            const sandboxProfileId =
              config.sandbox_mode === "workspace-write"
                ? ":workspace"
                : typeof config.sandbox_mode === "string"
                  ? `:${config.sandbox_mode}`
                  : "";
            const configuredPermission =
              availableProfiles.find((profile) => profile.id === sandboxProfileId)
                ?.id ||
              availableProfiles.find((profile) => profile.id === ":workspace")?.id ||
              availableProfiles.find((profile) => profile.id === ":read-only")?.id ||
              availableProfiles[0]?.id ||
              "";
            setModels(modelResult.data);
            void loadHarnessPlugins(client).then((plugins) => {
              if (disposed || manager.client(backend.id) !== source) return;
              setHarnessPlugins(plugins);
            });
            setRateLimits(rateLimitResult);
            setPermissionProfiles(availableProfiles);
            setSelectedModel((current) => current || configuredModel);
            setSelectedEffort((current) => current ?? normalized.effort);
            setSelectedServiceTier(
              (current) => current ?? normalized.serviceTier,
            );
            setSelectedPermission((current) => current || configuredPermission);
            setSelectedApprovalPolicy(
              (current) =>
                config.approval_policy ||
                (configuredPermission === ":danger-full-access"
                  ? "never"
                  : current),
            );
            setSelectedApprovalsReviewer(
              (current) => config.approvals_reviewer || current,
            );
            await loadThreads(client);
            if (disposed || manager.client(backend.id) !== source) return;
            setRefreshing(false);
            const currentThread = activeRef.current;
            if (currentThread?.id) {
              activeThreadTargetRef.current = currentThread.id;
              const resumed = await resumeThreadSession(client, currentThread.id);
              if (
                !disposed &&
                manager.client(backend.id) === source &&
                activeRef.current?.id === currentThread.id
              ) {
                const resumedSettings = normalizeModelSettings(
                  modelResult.data.find(
                    (model) => model.model === resumed.model,
                  ),
                  resumed.reasoningEffort,
                  resumed.serviceTier,
                );
                setActive({
                  ...resumed.thread,
                  isPinned: resumed.thread.isPinned === true,
                });
                resetOlderTurns(resumed.nextTurnsCursor);
                setConversationLoadState("ready");
                setConversationLoadError("");
                setActiveSettingsSynchronized(resumed.settingsSynchronized);
                setActiveThreadAccessMode(resumed.accessMode);
                setActiveThreadResumeError(resumed.resumeError ?? "");
                setSelectedModel(resumed.model ?? "");
                setSelectedEffort(resumedSettings.effort);
                setSelectedServiceTier(resumedSettings.serviceTier);
                if (resumed.approvalPolicy) {
                  setSelectedApprovalPolicy(resumed.approvalPolicy);
                }
                if (resumed.approvalsReviewer) {
                  setSelectedApprovalsReviewer(resumed.approvalsReviewer);
                }
                setSelectedPermission(resumed.activePermissionProfile?.id ?? "");
                const lastTurn = resumed.thread.turns?.at(-1);
                setBusy(
                  ["inProgress", "in_progress", "running"].includes(lastTurn?.status),
                );
              }
              void refreshThreadUsageSnapshot(currentThread.id);
            }
          }
          } catch (reason) {
            if (
              !disposed &&
              manager.client(backend.id) === source
            ) {
              setRefreshing(false);
              notifyBusy(reason);
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
              if (manager.client(backend.id) === source) {
                manager.socket(backend.id)?.close(
                  1011,
                  "workspace initialization failed",
                );
              }
            }
          }
        })();
      },
    });
    connectionManagerRef.current = manager;
    manager.sync([backend]);
    const unbindConnectionRecovery = bindConnectionRecovery({
      reconnect: () =>
        recoverBackendConnection(
          clientRef.current,
          () =>
            reconnectAndWaitUntilReady(
              () => manager.reconnect(backend.id),
              () => disposed || clientRef.current != null,
            ),
          reconcileActiveThread,
        ),
    });
    return () => {
      disposed = true;
      unbindConnectionRecovery();
      manager.close();
      if (connectionManagerRef.current === manager) {
        connectionManagerRef.current = null;
      }
      clientRef.current = null;
    };
  }, [backend.baseUrl, backend.id, backend.token]);

  function invalidateImageReads() {
    imageReadGenerationRef.current.invalidate();
    setImageReading(false);
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  function resetDraftContext() {
    draftContextGenerationRef.current += 1;
    invalidateImageReads();
    setPendingSteerMessage(null);
  }

  function resetOlderTurns(cursor: string | null = null) {
    olderTurnsGenerationRef.current += 1;
    olderTurnsLoadingRef.current = false;
    olderTurnsCursorRef.current = cursor;
    setOlderTurnsState(cursor ? "idle" : "exhausted");
  }

  async function loadOlderTurns() {
    const client = clientRef.current;
    const threadId = String(activeRef.current?.id ?? "");
    const cursor = olderTurnsCursorRef.current;
    if (olderTurnsLoadingRef.current) return true;
    if (!client || !threadId || !cursor) {
      return false;
    }

    const generation = olderTurnsGenerationRef.current;
    olderTurnsLoadingRef.current = true;
    setOlderTurnsState("loading");
    try {
      const page = await loadOlderThreadTurns(client, threadId, cursor);
      if (
        generation !== olderTurnsGenerationRef.current ||
        String(activeRef.current?.id ?? "") !== threadId
      ) {
        return false;
      }
      setActive((current) =>
        current && String(current.id) === threadId
          ? {
              ...current,
              turns: prependUniqueTurns(
                current.turns ?? [],
                page.turns,
              ),
            }
          : current,
      );
      olderTurnsCursorRef.current = page.nextCursor;
      setOlderTurnsState(page.nextCursor ? "idle" : "exhausted");
      return true;
    } catch {
      if (
        generation === olderTurnsGenerationRef.current &&
        String(activeRef.current?.id ?? "") === threadId
      ) {
        setOlderTurnsState("error");
      }
      return false;
    } finally {
      if (generation === olderTurnsGenerationRef.current) {
        olderTurnsLoadingRef.current = false;
      }
    }
  }

  async function loadThreadDetail(threadId: string, sequence: number) {
    const client = clientRef.current;
    try {
      if (!client) throw new Error(t("设备尚未连接，请稍后重试"));
      const session = await resumeThreadSession(client, threadId);
      if (sequence !== openSequenceRef.current) {
        if (activeThreadTargetRef.current !== threadId) {
          void client
            .request("thread/unsubscribe", { threadId })
            .catch(() => undefined);
        }
        return;
      }
      if (!session.thread?.id) {
        throw new Error(t("会话详情返回无效，请重试"));
      }
      const resumedSettings = normalizeModelSettings(
        models.find((model) => model.model === session.model),
        session.reasoningEffort,
        session.serviceTier,
      );
      setActive({
        ...session.thread,
        isPinned: session.thread.isPinned === true,
      });
      resetOlderTurns(session.nextTurnsCursor);
      setActiveSettingsSynchronized(session.settingsSynchronized);
      setActiveThreadAccessMode(session.accessMode);
      setActiveThreadResumeError(session.resumeError ?? "");
      // 问一次线程的 harness 归属：外部 harness 线程要显示绑定关系，而且
      // turn/start 不能再带官方 model（会被上游以 -32602 拒绝）。顺带把生效的
      // 模型/思考/权限和该 harness 的目录拉回来——否则中间那个下拉框在已有
      // 线程上是空的。
      void client
        .request(THREAD_INSPECT_METHOD, { threadId })
        .then((payload) => {
          if (sequence !== openSequenceRef.current) return;
          const binding = threadHarnessBinding(payload);
          setActiveHarnessId(binding?.harnessId ?? null);
          if (!binding) return;
          setSelectedHarnessModelId(binding.effectiveModelId ?? null);
          setSelectedHarnessThinkingId(binding.effectiveThinkingOptionId ?? null);
          setSelectedHarnessPermissionModeId(
            binding.effectivePermissionModeId ?? null,
          );
          void inspectHarness(client, binding.harnessId, session.thread.cwd ?? null)
            .then((inspection) => {
              if (sequence === openSequenceRef.current) {
                setHarnessInspection(inspection);
              }
            })
            .catch(() => undefined);
        })
        .catch(() => {
          // 非 codexhost 后端不认这个方法：当官方线程处理即可。
          if (sequence === openSequenceRef.current) setActiveHarnessId(null);
        });
      setSelectedModel(session.model ?? "");
      setSelectedEffort(resumedSettings.effort);
      setSelectedServiceTier(resumedSettings.serviceTier);
      if (session.approvalPolicy) {
        setSelectedApprovalPolicy(session.approvalPolicy);
      }
      if (session.approvalsReviewer) {
        setSelectedApprovalsReviewer(session.approvalsReviewer);
      }
      setSelectedPermission(session.activePermissionProfile?.id ?? "");
      setConversationLoadState("ready");
      setConversationLoadError("");
      const lastTurn = session.thread.turns?.at(-1);
      setBusy(
        ["inProgress", "in_progress", "running"].includes(lastTurn?.status),
      );
      void refreshThreadUsageSnapshot(threadId);

      if (session.thread.cwd) {
        void client
          .request<{ data: AnyRecord[] }>("permissionProfile/list", {
            limit: 100,
            cwd: session.thread.cwd,
          })
          .then((result) => {
            if (sequence === openSequenceRef.current) {
              setPermissionProfiles(result.data.filter((profile) => profile.allowed));
            }
          })
          .catch(() => undefined);
      }
    } catch (reason) {
      if (sequence === openSequenceRef.current) {
        setBusy(false);
        setSteering(false);
        setConversationLoadState("error");
        notifyBusy(reason);
        setConversationLoadError(
          reason instanceof Error ? reason.message : String(reason),
        );
      }
    } finally {
      if (sequence === openSequenceRef.current) setOpeningThreadId("");
    }
  }

  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ cwd: string; name: string }> = [];
    for (const thread of threads) {
      const cwd =
        typeof thread.cwd === "string" ? thread.cwd.trim() : "";
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      options.push({
        cwd,
        name: cwd.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) || cwd,
      });
    }
    return options;
  }, [threads]);

  function openThread(thread: AnyRecord) {
    const sequence = ++openSequenceRef.current;
    markThreadRead(String(thread.id));
    resetDraftContext();
    setDraft("");
    setDraftImages([]);
    setDraftFiles((current) => {
      current.forEach((file) => URL.revokeObjectURL(file.previewUrl));
      return [];
    });
    setOpeningThreadId(thread.id);
    setError("");
    setBusy(false);
    setStartingThreadContext(null);
    setNewChatPermissionMode(null);
    setSteering(false);
    setConversationLoadError("");
    setConversationLoadState("loading");
    setActiveThreadAccessMode("interactive");
    setActiveThreadResumeError("");
    // 在 thread/inspect 回来之前先清掉 harness 相关状态：否则中间那个 chip 会
    // 短暂显示上一条线程的模型，而这条线程绑的是哪个 harness 要等 inspect 才知道。
    setActiveHarnessId(null);
    setHarnessInspection(null);
    setSelectedHarnessModelId(null);
    setSelectedHarnessThinkingId(null);
    setSelectedHarnessPermissionModeId(null);
    resetOlderTurns();
    activeThreadTargetRef.current = thread.id;
    setActive({
      ...thread,
      turns: thread.turns ?? [],
    });
    void loadThreadDetail(thread.id, sequence);
  }

  function retryThreadDetail() {
    const threadId = activeRef.current?.id;
    if (!threadId) return;
    const sequence = ++openSequenceRef.current;
    activeThreadTargetRef.current = threadId;
    setOpeningThreadId(threadId);
    setConversationLoadError("");
    setConversationLoadState("loading");
    resetOlderTurns();
    void loadThreadDetail(threadId, sequence);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (active?.id && activeThreadAccessMode !== "interactive") return;
    const text = draft.trim();
    const pendingImages = draftImages;
    const pendingFiles = draftFiles;
    if (
      imageReading ||
      (!text && !pendingImages.length && !pendingFiles.length) ||
      !clientRef.current
    ) {
      return;
    }
    const draftContext = draftContextGenerationRef.current;
    const conversationBusy = active?.id
      ? busy
      : startingThreadContext === draftContextGenerationRef.current;
    if (conversationBusy) {
      let sent = false;
      const threadId = String(active?.id ?? "");
      const turnId = activeTurnId(active);
      if (!threadId || !turnId) {
        setError(t("当前任务正在启动，请稍后再引导"));
        return;
      }
      const clientUserMessageId =
        `steer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const pendingSteerText =
        text ||
        (pendingFiles.length
          ? t("{count} 个文件", { count: pendingFiles.length })
          : t("{count} 张图片", { count: pendingImages.length }));
      invalidateImageReads();
      setDraft("");
      setDraftImages([]);
      setDraftFiles([]);
      setSteering(true);
      setPendingSteerMessage({
        id: clientUserMessageId,
        threadId,
        text: pendingSteerText,
      });
      setError("");
      try {
        setImageReading(Boolean(pendingFiles.length));
        const uploadedFiles = await Promise.all(
          pendingFiles.map((file) => uploadFile(backend, file.file)),
        );
        await clientRef.current.request(
          "turn/steer",
          buildTurnSteerParams({
            threadId,
            turnId,
            input: buildTurnInput(text, pendingImages, uploadedFiles),
            clientUserMessageId,
          }),
        );
        sent = true;
      } catch (reason) {
        setPendingSteerMessage((current) =>
          clearPendingSteerForRequest(current, clientUserMessageId),
        );
        if (draftContext === draftContextGenerationRef.current) {
          setDraft((current) => mergeSteerDraft(current, text));
          setDraftImages((current) =>
            mergeDraftImages(current, pendingImages)
          );
          setDraftFiles((current) =>
            current.length ? current : pendingFiles,
          );
          notifyBusy(reason);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (draftContext === draftContextGenerationRef.current) {
          setSteering(false);
          setImageReading(false);
        }
      }
      if (sent && draftContext === draftContextGenerationRef.current) {
        pendingFiles.forEach((file) => URL.revokeObjectURL(file.previewUrl));
      }
      return;
    }
    invalidateImageReads();
    setDraft("");
    setDraftImages([]);
    setDraftFiles([]);
    setBusy(true);
    if (!active?.id) setStartingThreadContext(draftContext);
    const pendingTurnId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let thread = active;
    let sent = false;
    // 这条消息会不会开出一条新线程——决定要不要用首段文本给它命名。
    const startedNewThread = !thread?.id;
    try {
      setImageReading(Boolean(pendingFiles.length));
      const uploadedFiles = await Promise.all(
        pendingFiles.map((file) => uploadFile(backend, file.file)),
      );
      const shouldSendSettings = !thread?.id || activeSettingsSynchronized;
      const effectivePermission =
        !thread?.id && newChatPermissionMode
          ? newChatPermissionMode.permissions
          : selectedPermission;
      const effectiveApprovalPolicy =
        !thread?.id && newChatPermissionMode
          ? newChatPermissionMode.approvalPolicy
          : selectedApprovalPolicy;
      const effectiveApprovalsReviewer =
        !thread?.id && newChatPermissionMode
          ? newChatPermissionMode.approvalsReviewer
          : selectedApprovalsReviewer;
      if (!thread?.id) {
        const started = await clientRef.current.request<{
          thread: AnyRecord;
          model?: string;
          reasoningEffort?: string | null;
          serviceTier?: string | null;
          approvalPolicy?: ApprovalPolicy;
          approvalsReviewer?: ApprovalsReviewer;
          activePermissionProfile?: { id: string } | null;
        }>("thread/start", {
          cwd: thread?.cwd ?? null,
          // harness 路由优先：选中外部 harness 时这条链路的 model 就是它，
          // 与官方模型互斥（见 harness-inspect.ts 的说明）。
          ...(harnessRoute ?? selectedModel
            ? { model: harnessRoute ?? selectedModel }
            : {}),
          ...(selectedServiceTier ? { serviceTier: selectedServiceTier } : {}),
          ...(effectivePermission ? { permissions: effectivePermission } : {}),
          approvalPolicy: effectiveApprovalPolicy,
          approvalsReviewer: effectiveApprovalsReviewer,
        });
        thread = started.thread;
        // harness 已在这个线程上绑定，会话中不可更换——记下来，既用于显示，
        // 也用于决定 turn/start 要不要带 model。
        setActiveHarnessId(selectedHarnessId);
        activeThreadTargetRef.current = thread.id;
        setThreads((current) => [
          // 先本地填上 preview，侧边栏立刻显示首段文本而不是「新对话」；
          // 真正的 name 由下面的 thread/name/set 落库（见其注释）。
          {
            ...thread!,
            preview: firstMessageTitle(text),
            status: { type: "active" },
          },
          ...current.filter((entry) => entry.id !== thread!.id),
        ]);
        const startedModel = started.model || selectedModel;
        const startedSettings = normalizeModelSettings(
          models.find((model) => model.model === startedModel),
          started.reasoningEffort ?? selectedEffort,
          started.serviceTier ?? selectedServiceTier,
        );
        if (draftContext === draftContextGenerationRef.current) {
          setStartingThreadContext(null);
          if (started.model) setSelectedModel(started.model);
          setSelectedEffort(startedSettings.effort);
          setSelectedServiceTier(startedSettings.serviceTier);
          if (started.approvalPolicy) {
            setSelectedApprovalPolicy(started.approvalPolicy);
          }
          if (started.approvalsReviewer) {
            setSelectedApprovalsReviewer(started.approvalsReviewer);
          }
          if (started.activePermissionProfile?.id) {
            setSelectedPermission(started.activePermissionProfile.id);
          }
          setActiveSettingsSynchronized(true);
          setActive(thread);
        }
      }
      const localItem = {
        id: `local-${pendingTurnId}`,
        type: "userMessage",
        content: buildOptimisticUserContent(text, pendingImages, uploadedFiles),
      };
      const pendingSequence = ++pendingSequenceRef.current;
      if (draftContext === draftContextGenerationRef.current) {
        setActive((current) => {
          if (!current || current.id !== thread!.id) return current;
          return {
            ...current,
            turns: [
              ...(current.turns ?? thread!.turns ?? []),
              {
                ...createPendingTurn(
                  pendingTurnId,
                  localItem,
                  pendingSequence,
                ),
              },
            ],
          };
        });
      }
      const startedTurn = await clientRef.current.request<{ turn: AnyRecord }>("turn/start", {
        threadId: thread.id,
        input: buildTurnInput(text, pendingImages, uploadedFiles),
        // harness 线程不带 model/effort/serviceTier：那三项是官方模型的设置，
        // 发过去会被上游的 #startExternalTurn 以 -32602 "Turn Model carrier does
        // not belong to the Thread Harness" 拒绝。harness 的模型/思考/权限改走
        // codexhost/thread/*/select。
        ...(shouldSendSettings && !activeHarnessId && selectedModel
          ? { model: selectedModel }
          : {}),
        ...(shouldSendSettings && !activeHarnessId && selectedEffort
          ? { effort: selectedEffort }
          : {}),
        ...(shouldSendSettings && !activeHarnessId && selectedServiceTier
          ? { serviceTier: selectedServiceTier }
          : {}),
        ...(shouldSendSettings && effectivePermission
          ? { permissions: effectivePermission }
          : {}),
        ...(shouldSendSettings
          ? {
              approvalPolicy: effectiveApprovalPolicy,
              approvalsReviewer: effectiveApprovalsReviewer,
            }
          : {}),
      });
      sent = true;
      if (startedNewThread) {
        // 首段文本写进 name：侧边栏读 thread/list（外部 harness 线程那里
        // preview 恒为空串）、标题栏读 thread/resume，同一个 titleOf 于是有两个
        // 结果。写进 name 才能让三处一致，codexhost 自己的列表也跟着对
        // （详见 thread-metadata.ts 的说明）。
        // 命名失败不影响消息本身，所以静默忽略。
        void setThreadNameFromFirstMessage(clientRef.current, thread.id, text)
          .then((name) => {
            if (!name) return;
            setThreads((current) =>
              current.map((entry) =>
                entry.id === thread!.id ? { ...entry, name } : entry,
              ),
            );
            setActive((current) =>
              current && current.id === thread!.id
                ? { ...current, name }
                : current,
            );
          })
          .catch(() => undefined);
      }
      if (draftContext === draftContextGenerationRef.current) {
        setActive((current) => {
          if (!current) return current;
          return applyTurnStarted(current, {
            threadId: thread!.id,
            turn: startedTurn.turn,
          });
        });
      }
    } catch (reason) {
      if (thread?.id) {
        setThreads((current) =>
          current.map((entry) =>
            entry.id === thread!.id
              ? { ...entry, status: { type: "idle" } }
              : entry,
          ),
        );
        void loadThreads().catch(() => undefined);
      }
      if (draftContext === draftContextGenerationRef.current) {
        setBusy(false);
        setStartingThreadContext(null);
        setActive((current) =>
          current && current.id === thread?.id
            ? removePendingTurn(current, pendingTurnId)
            : current,
        );
        setDraft((current) => current || text);
        setDraftImages((current) => mergeDraftImages(current, pendingImages));
        setDraftFiles((current) =>
          current.length ? current : pendingFiles,
        );
        notifyBusy(reason);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (draftContext === draftContextGenerationRef.current) {
        setImageReading(false);
      }
    }
    if (sent && draftContext === draftContextGenerationRef.current) {
      pendingFiles.forEach((file) => URL.revokeObjectURL(file.previewUrl));
    }
  }

  async function selectImages(files: FileList | null) {
    if (
      !files?.length ||
      (active?.id && activeThreadAccessMode !== "interactive")
    ) return;
    const generation = imageReadGenerationRef.current.begin();
    const existingBytes = draftImages.reduce(
      (total, image) => total + image.size,
      0,
    );
    setImageReading(true);
    try {
      const selected = Array.from(files);
      const imageFiles = selected.filter(isNativeImageFile);
      const attachmentFiles = selected.filter((file) => !isNativeImageFile(file));
      const result = await prepareImageFiles(
        imageFiles,
        draftImages.length,
        undefined,
        existingBytes,
      );
      if (!imageReadGenerationRef.current.isCurrent(generation)) return;
      const attachmentResult = prepareAttachmentFiles(
        attachmentFiles,
        draftFiles.length,
      );
      setDraftImages((current) => mergeDraftImages(current, result.images));
      setDraftFiles((current) => [...current, ...attachmentResult.files].slice(0, 4));
      const errors = [...result.errors, ...attachmentResult.errors];
      if (errors.length) setError(errors.join("；"));
      else setError("");
    } finally {
      if (imageReadGenerationRef.current.isCurrent(generation)) {
        setImageReading(false);
      }
    }
  }

  async function interrupt() {
    if (activeThreadAccessMode !== "interactive") return;
    const turn = active?.turns?.at(-1);
    if (!turn) return;
    try {
      await clientRef.current?.request("turn/interrupt", {
        threadId: active!.id,
        turnId: turn.id,
      });
    } catch (reason) {
      notifyBusy(reason);
      throw reason;
    }
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(
      () => setNotice((current) => (current === message ? "" : current)),
      1800,
    );
  }

  /** 切换/挂载线程时拉一次用量基线；非 codexhost 后端静默失败。 */
  function refreshThreadUsageSnapshot(threadId: unknown) {
    const id = String(threadId ?? "");
    const client = clientRef.current;
    if (!id || !client) return;
    void inspectThreadUsage(client, id).then((usage) => {
      if (!usage) return;
      setThreadUsageByThread((current) =>
        String(activeRef.current?.id ?? "") === id || current[id]
          ? { ...current, [id]: usage }
          : current,
      );
    });
  }

  /** busy 准入冲突只提示、不重试不排队。 */
  function notifyBusy(reason: unknown) {
    const hint = busyHintFor(reason);
    if (hint) showNotice(t(hint));
  }

  async function togglePinned() {
    const client = clientRef.current;
    const thread = activeRef.current;
    if (
      !client ||
      !thread?.id ||
      pendingAction ||
      activeThreadAccessMode !== "interactive"
    ) return false;
    const nextPinned = thread.isPinned !== true;
    setPendingAction("pin");
    setError("");
    try {
      const refreshed = await setThreadPinned(
        client,
        thread.id,
        nextPinned,
      );
      const persistedPinned = refreshed.isPinned;
      setThreads((current) =>
        current.map((entry) =>
          entry.id === thread.id
            ? { ...entry, isPinned: persistedPinned }
            : entry,
        ),
      );
      setActive((current) =>
        current?.id === thread.id
          ? { ...current, isPinned: persistedPinned }
          : current,
      );
      showNotice(persistedPinned ? t("已置顶") : t("已取消置顶"));
      return true;
    } catch {
      setError(nextPinned ? t("置顶失败，请重试") : t("取消置顶失败，请重试"));
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function renameThread() {
    const client = clientRef.current;
    const thread = activeRef.current;
    if (
      !client ||
      !thread?.id ||
      pendingAction ||
      activeThreadAccessMode !== "interactive"
    ) return false;
    const name = window.prompt(t("输入新的会话名称"), titleOf(thread))?.trim();
    if (!name || name === titleOf(thread)) return false;
    setPendingAction("rename");
    setError("");
    try {
      await client.request("thread/name/set", {
        threadId: thread.id,
        name,
      });
      setThreads((current) =>
        current.map((entry) =>
          entry.id === thread.id ? { ...entry, name } : entry,
        ),
      );
      setActive((current) =>
        current?.id === thread.id ? { ...current, name } : current,
      );
      showNotice(t("已重命名"));
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("重命名失败，请重试"),
      );
      return false;
    } finally {
      setPendingAction("");
    }
  }

  async function archiveThread() {
    const client = clientRef.current;
    const thread = activeRef.current;
    if (
      !client ||
      !thread?.id ||
      pendingAction ||
      activeThreadAccessMode !== "interactive"
    ) return false;
    setPendingAction("archive");
    setError("");
    try {
      await client.request("thread/archive", { threadId: thread.id });
      markThreadRead(String(thread.id));
      setThreads((current) =>
        current.filter((entry) => entry.id !== thread.id),
      );
      const archivedThreadStillOpen =
        activeThreadTargetRef.current === thread.id;
      setActive((current) =>
        activeThreadAfterArchive(current, thread.id),
      );
      if (archivedThreadStillOpen) {
        activeThreadTargetRef.current = null;
        setConversationLoadState("idle");
        onOpenSidebar();
      }
      showNotice(t("已归档"));
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("归档失败，请重试"),
      );
      return false;
    } finally {
      setPendingAction("");
    }
  }

  const selectedModelEntry =
    models.find((model) => model.model === selectedModel) ?? null;
  const selectedModelLabel =
    !activeSettingsSynchronized && active?.id
      ? t("沿用线程模型")
      : selectedModelEntry?.displayName ||
        selectedModel ||
        t("默认模型");
  const effortOptions = effortOptionsForModel(selectedModelEntry);
  // 选中外部 harness 时，中间那个 chip 显示的是「harness · 模型 思考档位」——
  // 模型与思考档位都在那个下拉框里选（harness picker 只负责选 harness）。
  const harnessModelLabel =
    harnessInspection?.models.find((model) => model.id === selectedHarnessModelId)
      ?.label ?? "";
  const harnessThinkingLabel =
    harnessInspection?.thinkingOptions.find(
      (option) => option.id === selectedHarnessThinkingId,
    )?.label ?? "";
  // 中间那个 chip 只显示模型：harness 归左边那个 chip 管，这里再显示一遍只会
  // 让人以为它能选 harness。
  //
  // 取值必须看「线程实际绑定的 harness」而不是选择器状态：之前用的是
  // selectedHarnessId，于是在 picker 里点过 claude-code 之后，再打开一条 Pi
  // 线程，中间就会显示成 Claude Code——线程明明绑的是 pi。
  const chipHarnessId = active?.id ? activeHarnessId : selectedHarnessId;
  const agentChipModelLabel = chipHarnessId
    ? harnessModelLabel || t("默认模型")
    : selectedModelLabel;
  const agentChipEffort = chipHarnessId
    ? harnessThinkingLabel || t("默认")
    : selectedEffort;
  const speedOptions = speedOptionsForModel(selectedModelEntry);
  const selectedSpeedLabel =
    speedOptions.find((option) => option.id === selectedServiceTier)?.label ??
    t("正常");
  const permissionModes = permissionModesFromProfiles(
    permissionProfiles as Array<{ id: string; allowed?: boolean }>,
  );
  const effectivePermissionMode =
    !active?.id && newChatPermissionMode
      ? newChatPermissionMode
      : null;
  const selectedPermissionModeId = permissionModeFromSettings(
    effectivePermissionMode?.permissions ?? selectedPermission,
    effectivePermissionMode?.approvalPolicy ?? selectedApprovalPolicy,
    effectivePermissionMode?.approvalsReviewer ?? selectedApprovalsReviewer,
  );
  const selectedPermissionMode = permissionModes.find(
    (mode) => mode.id === selectedPermissionModeId,
  );
  const selectedPermissionLabel =
    !activeSettingsSynchronized && active?.id
      ? t("沿用线程权限")
      : selectedPermissionMode?.label ??
        permissionProfileLabel(
          selectedPermission,
          permissionProfiles.find(
            (profile) => profile.id === selectedPermission,
          )?.description,
        );
  const chooseModel = (modelId: string) => {
    const model = models.find((option) => option.model === modelId);
    const normalized = normalizeModelSettings(
      model,
      selectedEffort,
      selectedServiceTier,
    );
    setSelectedModel(modelId);
    setSelectedEffort(normalized.effort);
    setSelectedServiceTier(normalized.serviceTier);
  };
  const choosePermissionMode = (modeId: PermissionModeId) => {
    const mode = permissionModes.find((option) => option.id === modeId);
    if (!mode) return;
    setSelectedPermission(mode.permissions);
    setSelectedApprovalPolicy(mode.approvalPolicy);
    setSelectedApprovalsReviewer(mode.approvalsReviewer);
    if (!active?.id) setNewChatPermissionMode(mode);
    setPicker(null);
  };
  /**
   * harnessId 为 null 表示切回官方 Codex：清空选择即可。
   *
   * codex-host 把 `codex` 当保留 id（encodeHarnessRoute 会拒绝它），所以官方
   * 那条路**不发任何路由**，thread/start 带普通官方 model——这也是为什么列表里
   * 必须有这个选项：没有它，选了外部 harness 就退不回来。
   */
  const chooseHarness = (harnessId: string | null) => {
    setHarnessInspection(null);
    setHarnessInspectError("");
    setSelectedHarnessId(harnessId);
    if (!harnessId) return;
    const client = clientRef.current;
    if (!client) return;
    void inspectHarness(client, harnessId, active?.cwd ?? null)
      .then((inspection) => {
        setHarnessInspection(inspection);
        if (inspection.status !== "ready") return;
        // 换 harness 一律重置成新 harness 的默认值——沿用上一个 harness 的
        // model/thinking id 是没有意义的，而且会被上游拒绝。
        setSelectedHarnessModelId(
          inspection.defaultModelId ?? inspection.models[0]?.id ?? null,
        );
        setSelectedHarnessThinkingId(
          inspection.defaultThinkingOptionId ?? null,
        );
        setSelectedHarnessPermissionModeId(
          inspection.defaultPermissionModeId ?? null,
        );
      })
      .catch((reason) => {
        setHarnessInspectError(
          reason instanceof Error ? reason.message : String(reason),
        );
      });
  };
  /**
   * 会话中改 harness 的模型/思考/权限，走 codexhost/thread 下的三个 select RPC。
   *
   * 新会话里这三个值只记在本地，最后随路由进 thread/start；已经有线程时必须
   * 显式调 select，否则选了等于没选。权限模式还要看 permissionModeScope：
   * atCreate 的 harness 创建后不可改，上游会拒。
   */
  const chooseHarnessModel = (modelId: string) => {
    setSelectedHarnessModelId(modelId);
    setPicker(null);
    const client = clientRef.current;
    if (!client || !active?.id || !activeHarnessId) return;
    void selectThreadModel(client, active.id, modelId).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  const chooseHarnessThinking = (thinkingOptionId: string) => {
    setSelectedHarnessThinkingId(thinkingOptionId);
    setPicker(null);
    const client = clientRef.current;
    if (!client || !active?.id || !activeHarnessId) return;
    void selectThreadThinking(client, active.id, thinkingOptionId).catch(
      (reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };
  const chooseHarnessPermissionMode = (permissionModeId: string) => {
    setSelectedHarnessPermissionModeId(permissionModeId);
    setPicker(null);
    const client = clientRef.current;
    if (!client || !active?.id || !activeHarnessId) return;
    if (harnessInspection?.capabilities.permissionModeScope === "atCreate") {
      return;
    }
    void selectThreadPermissionMode(client, active.id, permissionModeId).catch(
      (reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };
  // harness 只在 thread/start 时绑定：这个路由字符串就是 thread/start 的 model。
  const harnessRoute = tryEncodeHarnessRoute(
    selectedHarnessId
      ? {
          harnessId: selectedHarnessId,
          ...(selectedHarnessModelId
            ? { model: selectedHarnessModelId }
            : {}),
          ...(selectedHarnessThinkingId
            ? { thinkingOptionId: selectedHarnessThinkingId }
            : {}),
          ...(selectedHarnessPermissionModeId
            ? { permissionModeId: selectedHarnessPermissionModeId }
            : {}),
        }
      : null,
  );
  const approval = requests[0] ?? null;
  const finishRequest = (decision: "accept" | "decline") => {
    if (!approval) return;
    const params = (approval.params ?? {}) as AnyRecord;
    if (approval.method === "item/permissions/requestApproval") {
      const requested = (params.permissions ?? {}) as AnyRecord;
      const granted = {
        ...(requested.fileSystem != null ? { fileSystem: requested.fileSystem } : {}),
        ...(requested.network != null ? { network: requested.network } : {}),
      };
      clientRef.current?.respond(approval.id!, {
        permissions: decision === "accept" ? granted : {},
        scope: "turn",
      });
    } else {
      clientRef.current?.respond(approval.id!, { decision });
    }
    setRequests((current) => current.slice(1));
  };
  const answerQuestions = () => {
    if (!approval) return;
    const questions = ((approval.params as AnyRecord)?.questions ?? []) as AnyRecord[];
    clientRef.current?.respond(approval.id!, {
      answers: Object.fromEntries(
        questions.map((question) => [question.id, { answers: [userAnswers[question.id] ?? ""] }]),
      ),
    });
    setUserAnswers({});
    setRequests((current) => current.slice(1));
  };

  const startNewChat = (
    cwd: string | null = null,
    nextDraft = "",
    nextDraftImages: DraftImage[] = [],
    nextDraftFiles: DraftFile[] = [],
  ) => {
    const savedCwd = window.localStorage.getItem(
      `codex-mobile:new-chat-project:${backend.id}`,
    );
    const selectedCwd =
      cwd ||
      projectOptions.find((project) => project.cwd === savedCwd)?.cwd ||
      projectOptions[0]?.cwd ||
      null;
    openSequenceRef.current += 1;
    activeThreadTargetRef.current = null;
    // 新会话不再绑定任何 harness；选择器重新可用（harness 只在 thread/start
    // 时绑定，会话中换不了）。同时清掉上一条线程带来的 harness 目录与选中态，
    // 否则中间那个 chip 会继续显示上一条线程的模型。
    setActiveHarnessId(null);
    setSelectedHarnessId(null);
    setHarnessInspection(null);
    setHarnessInspectError("");
    setSelectedHarnessModelId(null);
    setSelectedHarnessThinkingId(null);
    setSelectedHarnessPermissionModeId(null);
    resetDraftContext();
    const defaultPermissionMode =
      defaultNewChatPermissionMode(
        permissionProfiles as Array<{ id: string; allowed?: boolean }>,
      );
    setOpeningThreadId("");
    setBusy(false);
    setStartingThreadContext(null);
    setSteering(false);
    setImageReading(false);
    setError("");
    setDraft(nextDraft);
    setDraftImages(nextDraftImages);
    setDraftFiles(nextDraftFiles);
    setConversationLoadState("ready");
    setConversationLoadError("");
    resetOlderTurns();
    setActiveSettingsSynchronized(true);
    setActiveThreadAccessMode("interactive");
    setActiveThreadResumeError("");
    if (defaultPermissionMode) {
      setNewChatPermissionMode(defaultPermissionMode);
      setSelectedPermission(defaultPermissionMode.permissions);
      setSelectedApprovalPolicy(defaultPermissionMode.approvalPolicy);
      setSelectedApprovalsReviewer(defaultPermissionMode.approvalsReviewer);
    }
    setActive({
      id: "",
      turns: [],
      preview: t("新对话"),
      cwd: selectedCwd,
    });
  };

  const chooseNewChatProject = (cwd: string) => {
    window.localStorage.setItem(
      `codex-mobile:new-chat-project:${backend.id}`,
      cwd,
    );
    setActive((current) =>
      current && !current.id ? { ...current, cwd } : current,
    );
  };

  async function loadAllProjectThreads(cwd: string) {
    const client = clientRef.current;
    if (!client) return;
    setLoadingProjectCwd(cwd);
    try {
      const all: AnyRecord[] = [];
      let cursor: string | null = null;
      do {
        const result: { data: AnyRecord[]; nextCursor?: string | null } =
          await client.request("thread/list", {
            limit: 50,
            cwd,
            sortKey: "updated_at",
            ...(cursor ? { cursor } : {}),
          });
        all.push(...result.data);
        cursor = result.nextCursor ?? null;
      } while (cursor);
      fullyLoadedProjectCwdsRef.current.add(cwd);
      setThreads((current) => [
        ...current.filter((thread) => thread.cwd !== cwd),
        ...all,
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingProjectCwd((current) => (current === cwd ? "" : current));
    }
  }

  const handledCommandRef = useRef(0);
  useEffect(() => {
    if (
      !command ||
      command.backendId !== backend.id ||
      command.id === handledCommandRef.current
    ) {
      return;
    }
    handledCommandRef.current = command.id;
    if (command.type === "open" && command.thread) {
      openThread(command.thread);
    } else if (command.type === "new") {
      startNewChat(
        command.cwd ?? null,
        command.draft ?? "",
        command.draftImages ?? [],
        command.draftFiles ?? [],
      );
    } else if (command.type === "load-project" && command.cwd) {
      void loadAllProjectThreads(command.cwd);
    } else if (command.type === "retry-project" && command.cwd) {
      const client = clientRef.current;
      if (client) {
        void threadListLoaderRef.current!.loadProject(client, command.cwd);
      }
    }
  }, [backend.id, command, projectOptions]);

  const conversationBusy = active?.id
    ? busy
    : startingThreadContext === draftContextGenerationRef.current;

  return (
    <main className="app-shell">
      {active ? (
        <ConversationPage
          active={active}
          backendId={backend.id}
          backendName={backend.name}
          backends={backends.filter((entry) => entry.enabled)}
          projectOptions={projectOptions}
          loadState={conversationLoadState}
          loadError={conversationLoadError}
          olderTurnsState={olderTurnsState}
          connection={connection}
          client={clientRef.current}
          error={error}
          draft={draft}
          draftImages={draftImages}
          draftFiles={draftFiles}
          imageReading={imageReading}
          busy={conversationBusy}
          steering={steering}
          steerable={Boolean(activeTurnId(active))}
          pendingSteerText={
            pendingSteerMessage?.threadId === String(active.id)
              ? pendingSteerMessage.text
              : ""
          }
          accessMode={activeThreadAccessMode}
          resumeError={activeThreadResumeError}
          tokenUsage={tokenUsageByThread[active.id] ?? null}
          usage={threadUsageByThread[active.id] ?? null}
          rateLimits={rateLimits}
          pendingAction={pendingAction}
          selectedServiceTier={selectedServiceTier}
          selectedModelLabel={agentChipModelLabel}
          selectedEffort={agentChipEffort}
          selectedPermissionLabel={selectedPermissionLabel}
          imageInputRef={imageInputRef}
          onBack={onOpenSidebar}
          onNewChatBackendChange={(backendId) =>
            onSwitchNewChatBackend(backendId, draft, draftImages, draftFiles)
          }
          onNewChatProjectChange={chooseNewChatProject}
          onPin={togglePinned}
          onRename={renameThread}
          onArchive={archiveThread}
          onRetry={retryThreadDetail}
          onLoadOlderTurns={loadOlderTurns}
          onSubmit={send}
          onRemoveImage={(imageId) =>
            setDraftImages((current) =>
              current.filter((entry) => entry.id !== imageId),
            )
          }
          onRemoveFile={(fileId) =>
            setDraftFiles((current) => {
              const removed = current.find((entry) => entry.id === fileId);
              if (removed) URL.revokeObjectURL(removed.previewUrl);
              return current.filter((entry) => entry.id !== fileId);
            })
          }
          onSelectImages={selectImages}
          onOpenAgentSettings={() => setPicker("agent")}
          onOpenPermissionSettings={() => setPicker("permission")}
          onOpenHarnessSettings={() => setPicker("harness")}
          // 会话中不能换 harness（上游在 thread/start 时绑定），所以只在
          // 新会话里显示可选入口；已绑定的线程只显示当前 harness。
          showHarnessChip={!active?.id || Boolean(activeHarnessId)}
          harnessChipLabel={
            activeHarnessId
              ? harnessPluginName(activeHarnessId)
              : selectedHarnessId
                ? harnessPluginName(selectedHarnessId)
                : t("外部 Harness")
          }
          onDraftChange={setDraft}
          onInterrupt={interrupt}
        />
      ) : (
        <section className="conversation conversation-empty">
          <header className="conversation-header">
            <button
              className="round-button"
              aria-label={t("打开会话列表")}
              onClick={onOpenSidebar}
            >
              <AppIcon name="menu" />
            </button>
            <div className="thread-heading">
              <strong>Codex Mobile</strong>
              <span>
                <i className={`status-dot ${connection}`} />
                {backend.name}
              </span>
            </div>
          </header>
          <div className="empty-state">{t("从会话列表选择对话")}</div>
        </section>
      )}
      {notice && (
        <div className="notice-banner" role="status">
          {notice}
        </div>
      )}
      <ApprovalSheet
        approval={approval}
        userAnswers={userAnswers}
        onAnswerChange={(questionId, value) =>
          setUserAnswers((current) => ({
            ...current,
            [questionId]: value,
          }))
        }
        onSubmitAnswers={answerQuestions}
        onDecision={finishRequest}
      />
      <ComposerSettings
        picker={picker}
        effortOptions={effortOptions}
        speedOptions={speedOptions}
        permissionModes={permissionModes}
        models={models}
        harnessPlugins={harnessPlugins}
        // 必须是**当前生效**的 harness（有线程时来自 thread/inspect，新会话时
        // 来自选择器）。只传选择器状态的话，打开已有的 harness 线程时这里是
        // null，模型弹层会错误地列成官方模型。
        harnessId={chipHarnessId}
        harnessInspection={harnessInspection}
        harnessInspectError={harnessInspectError}
        selectedHarnessModelId={selectedHarnessModelId}
        selectedHarnessThinkingId={selectedHarnessThinkingId}
        selectedHarnessPermissionModeId={selectedHarnessPermissionModeId}
        selectedEffort={selectedEffort}
        selectedModel={selectedModel}
        selectedModelLabel={selectedModelLabel}
        selectedServiceTier={selectedServiceTier}
        selectedSpeedLabel={selectedSpeedLabel}
        selectedPermissionModeId={selectedPermissionModeId}
        onPickerChange={setPicker}
        onChooseEffort={setSelectedEffort}
        onChooseModel={chooseModel}
        onChooseSpeed={setSelectedServiceTier}
        onChoosePermissionMode={choosePermissionMode}
        onChooseHarness={chooseHarness}
        onChooseHarnessModel={chooseHarnessModel}
        onChooseHarnessThinking={chooseHarnessThinking}
        onChooseHarnessPermissionMode={chooseHarnessPermissionMode}
      />
    </main>
  );
}

export function App() {
  useI18n();
  const [initialRegistry] = useState<BackendRegistry>(() => {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    const initial = loadBackendRegistry(
      window.localStorage,
      window.location.origin,
      token,
    );
    if (initial.backends.length) {
      saveBackendRegistry(window.localStorage, initial);
    }
    return initial;
  });
  return <AppBootstrap initialRegistry={initialRegistry} />;
}

export function AppBootstrap({
  initialRegistry,
}: {
  initialRegistry: BackendRegistry;
}) {
  const [registry, setRegistry] = useState(initialRegistry);
  const [managerOpen, setManagerOpen] = useState(
    !initialRegistry.backends.length,
  );
  const appUpdate = useAppUpdate();

  if (registry.backends.length) {
    return (
      <ConfiguredApp
        initialRegistry={registry}
        appUpdate={appUpdate}
      />
    );
  }

  return (
    <main className="app-shell">
      <section className="empty-state">
        <h1>Codex Mobile</h1>
        <p>{t("添加设备后即可连接 Codex。")}</p>
        <button
          className="backend-add-device"
          type="button"
          onClick={() => setManagerOpen(true)}
        >
          {t("添加设备")}
        </button>
      </section>
      <BackendManagerSheet
        open={managerOpen}
        registry={registry}
        summaries={{}}
        onChange={(next) => {
          saveBackendRegistry(window.localStorage, next);
          setRegistry(next);
        }}
        onClose={() => setManagerOpen(false)}
        appUpdate={{
          supported: appUpdate.supported,
          currentVersion: appUpdate.state.currentVersion,
          checking: appUpdate.state.phase === "checking",
          status:
            appUpdate.state.phase === "current"
              ? t("已是最新版本")
              : appUpdate.state.phase === "error"
                ? appUpdate.state.error
                : undefined,
          onCheck: () => void appUpdate.check(true),
        }}
      />
      <AppUpdateSheet
        open={appUpdate.sheetOpen}
        state={appUpdate.state}
        onClose={() => appUpdate.setSheetOpen(false)}
        onInstall={appUpdate.install}
        onRetry={appUpdate.install}
      />
    </main>
  );
}

function ConfiguredApp({
  initialRegistry,
  appUpdate,
}: {
  initialRegistry: BackendRegistry;
  appUpdate: AppUpdateController;
}) {
  const [registry, setRegistry] = useState(initialRegistry);
  const [summaries, setSummaries] = useState<
    Record<string, BackendRuntimeSummary>
  >({});
  const [managerOpen, setManagerOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<
    Record<string, BackendThreadSnapshot>
  >({});
  const [listBackendId, setListBackendId] = useState(
    () =>
      window.localStorage.getItem("codex-mobile:list-backend") || "all",
  );
  const [query, setQuery] = useState("");
  const [projectVisibleCounts, setProjectVisibleCounts] = useState<
    Record<string, number>
  >({});
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState(() =>
    readCollapsedProjectKeys(window.localStorage),
  );
  const loadedProjectsRef = useRef(new Set<string>());
  const [command, setCommand] = useState<WorkspaceCommand | null>(null);
  const commandIdRef = useRef(0);
  const edgeTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const resetListExpansion = useCallback(() => {
    setProjectVisibleCounts({});
    loadedProjectsRef.current.clear();
  }, []);
  const {
    sidebarOpen,
    refreshVersion,
    openSidebar,
    closeSidebar,
    refresh: refreshAllBackends,
  } = useSidebarRefresh(resetListExpansion);
  const selectListBackend = useCallback((backendId: string) => {
    window.localStorage.setItem("codex-mobile:list-backend", backendId);
    setListBackendId(backendId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const backend of registry.backends) {
      if (!backend.enabled || backend.hostId) continue;
      void fetchBackendHostInfo(backend)
        .then((host) => {
          if (cancelled || !host.hostId.trim()) return;
          setRegistry((current) => {
            const target = current.backends.find(
              (entry) => entry.id === backend.id,
            );
            if (
              !target ||
              target.hostId ||
              target.baseUrl !== backend.baseUrl
            ) {
              return current;
            }
            const next = assignBackendHostId(
              current,
              backend.id,
              host.hostId,
            );
            if (next === current) return current;
            saveBackendRegistry(window.localStorage, next);
            return next;
          });
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [registry.backends]);

  useEffect(() => {
    if (
      sidebarOpen &&
      !(window.history.state as AnyRecord | null)?.codexMobileSidebar
    ) {
      window.history.pushState(
        {
          ...(window.history.state ?? {}),
          codexMobileSidebar: true,
        },
        "",
      );
    }
  }, [sidebarOpen]);

  useEffect(() => {
    const handlePopState = () => {
      if (sidebarOpen) closeSidebar();
    };
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      edgeTouchStartRef.current =
        !sidebarOpen && touch && touch.clientX <= 24
          ? { x: touch.clientX, y: touch.clientY }
          : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const start = edgeTouchStartRef.current;
      const touch = event.touches[0];
      if (!start || !touch) return;
      if (Math.abs(touch.clientY - start.y) > 44) {
        edgeTouchStartRef.current = null;
        return;
      }
      if (touch.clientX - start.x < 56) return;
      edgeTouchStartRef.current = null;
      openSidebar();
    };
    const handleTouchEnd = () => {
      edgeTouchStartRef.current = null;
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [closeSidebar, openSidebar, sidebarOpen]);

  const enabledBackends = useMemo(
    () => registry.backends.filter((backend) => backend.enabled),
    [registry.backends],
  );
  const mountedBackends = useMemo(
    () =>
      enabledBackends.length
        ? enabledBackends
        : registry.backends.slice(0, 1),
    [enabledBackends, registry.backends],
  );
  const selectedBackend =
    mountedBackends.find(
      (backend) => backend.id === registry.selectedBackendId,
    ) ?? mountedBackends[0];

  useEffect(() => {
    if (
      listBackendId !== "all" &&
      !mountedBackends.some((backend) => backend.id === listBackendId)
    ) {
      selectListBackend("all");
    }
  }, [listBackendId, mountedBackends, selectListBackend]);

  const persistRegistry = useCallback((next: BackendRegistry) => {
    saveBackendRegistry(window.localStorage, next);
    setRegistry(
      loadBackendRegistry(window.localStorage, window.location.origin),
    );
  }, []);

  const selectBackend = useCallback((backendId: string) => {
    setRegistry((current) => {
      const target = current.backends.find(
        (backend) => backend.id === backendId && backend.enabled,
      );
      if (!target || current.selectedBackendId === backendId) return current;
      const next = { ...current, selectedBackendId: backendId };
      saveBackendRegistry(window.localStorage, next);
      return next;
    });
  }, []);

  const updateSummary = useCallback((summary: BackendRuntimeSummary) => {
    setSummaries((current) => {
      const previous = current[summary.backendId];
      if (
        previous &&
        previous.connection === summary.connection &&
        previous.busy === summary.busy &&
        previous.approvalCount === summary.approvalCount &&
        previous.error === summary.error
      ) {
        return current;
      }
      return { ...current, [summary.backendId]: summary };
    });
  }, []);

  const updateSnapshot = useCallback((snapshot: BackendThreadSnapshot) => {
    setSnapshots((current) => {
      const previous = current[snapshot.backendId];
      if (
        previous &&
        previous.threads === snapshot.threads &&
        previous.projects === snapshot.projects &&
        previous.projectThreadStates === snapshot.projectThreadStates &&
        previous.loadingProjectCwd === snapshot.loadingProjectCwd &&
        previous.refreshing === snapshot.refreshing &&
        previous.threadListState === snapshot.threadListState &&
        previous.openingThreadId === snapshot.openingThreadId &&
        previous.error === snapshot.error
      ) {
        return current;
      }
      return { ...current, [snapshot.backendId]: snapshot };
    });
  }, []);

  const aggregatedThreads = useMemo(
    () =>
      aggregateThreads(
        mountedBackends,
        Object.fromEntries(
          mountedBackends.map((backend) => [
            backend.id,
            snapshots[backend.id]?.threads ?? [],
          ]),
        ),
      ),
    [mountedBackends, snapshots],
  );
  const scopedThreads = useMemo(
    () =>
      filterAggregatedThreads(
        listBackendId === "all"
          ? aggregatedThreads
          : aggregatedThreads.filter(
              (thread) => thread.backendId === listBackendId,
            ),
        query,
        listBackendId === "all",
      ),
    [aggregatedThreads, listBackendId, query],
  );
  const scopedSnapshots =
    listBackendId === "all"
      ? mountedBackends.map((backend) => snapshots[backend.id]).filter(Boolean)
      : [snapshots[listBackendId]].filter(Boolean);
  const scopedThreadCount =
    listBackendId === "all"
      ? aggregatedThreads.length
      : aggregatedThreads.filter(
          (thread) => thread.backendId === listBackendId,
        ).length;
  const threadListState: ThreadListState = scopedSnapshots.some(
    (snapshot) => snapshot.threadListState === "ready",
  )
    ? "ready"
    : scopedSnapshots.length &&
        scopedSnapshots.every(
          (snapshot) => snapshot.threadListState === "error",
        )
      ? "error"
      : "loading";
  const listError = scopedSnapshots
    .map((snapshot) => snapshot.error)
    .filter(Boolean)
    .join("；");
  const openingThreadId =
    scopedSnapshots
      .filter((snapshot) => snapshot.openingThreadId)
      .map(
        (snapshot) =>
          `${snapshot.backendId}:${snapshot.openingThreadId}`,
      )[0] ?? "";
  const projectDirectories =
    listBackendId === "all" ? [] : snapshots[listBackendId]?.projects ?? [];
  const projectThreadStates =
    listBackendId === "all"
      ? {}
      : snapshots[listBackendId]?.projectThreadStates ?? {};
  const loadingBackendIds = new Set(
    Object.values(snapshots)
      .filter((snapshot) =>
        Object.values(snapshot.projectThreadStates ?? {}).some(
          (state) => state === "loading",
        ),
      )
      .map((snapshot) => snapshot.backendId),
  );
  const refreshing = enabledBackends.some(
    (backend) => snapshots[backend.id]?.refreshing,
  );
  const loadingProjectKeys = new Set(
    Object.values(snapshots)
      .filter((snapshot) => snapshot.loadingProjectCwd)
      .map(
        (snapshot) =>
          `${snapshot.backendId}:${snapshot.loadingProjectCwd}`,
      ),
  );

  const toggleProject = useCallback(
    (backendId: string, cwd: string) => {
      const key = `${backendId}:${cwd}`;
      setProjectVisibleCounts((current) => ({
        ...current,
        [key]: (current[key] ?? 5) + 10,
      }));
      if (!loadedProjectsRef.current.has(key)) {
        loadedProjectsRef.current.add(key);
        setCommand({
          id: ++commandIdRef.current,
          backendId,
          type: "load-project",
          cwd,
        });
      }
    },
    [],
  );

  const toggleProjectCollapsed = useCallback(
    (backendId: string, cwd: string) => {
      const key = projectCollapseKey(backendId, cwd);
      setCollapsedProjectKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        writeCollapsedProjectKeys(window.localStorage, next);
        return next;
      });
    },
    [],
  );

  const retryProject = useCallback((backendId: string, cwd: string) => {
    setCommand({
      id: ++commandIdRef.current,
      backendId,
      type: "retry-project",
      cwd,
    });
  }, []);

  const openThread = useCallback(
    (item: AggregatedThreadItem) => {
      selectBackend(item.backendId);
      setCommand({
        id: ++commandIdRef.current,
        backendId: item.backendId,
        type: "open",
        thread: item.thread,
      });
      closeSidebar();
    },
    [closeSidebar, selectBackend],
  );

  const startNewChat = useCallback(() => {
    const savedBackendId = window.localStorage.getItem(
      "codex-mobile:new-chat-backend",
    );
    const backendId =
      listBackendId === "all"
        ? mountedBackends.find(
            (backend) => backend.id === savedBackendId,
          )?.id ??
          selectedBackend?.id ??
          mountedBackends[0]?.id
        : listBackendId;
    if (!backendId) return;
    window.localStorage.setItem("codex-mobile:new-chat-backend", backendId);
    selectBackend(backendId);
    setCommand({
      id: ++commandIdRef.current,
      backendId,
      type: "new",
      cwd: null,
    });
    closeSidebar();
  }, [
    closeSidebar,
    listBackendId,
    mountedBackends,
    selectBackend,
    selectedBackend?.id,
  ]);

  const switchNewChatBackend = useCallback(
    (
      backendId: string,
      currentDraft: string,
      currentDraftImages: DraftImage[],
      currentDraftFiles: DraftFile[],
    ) => {
      const target = mountedBackends.find(
        (backend) => backend.id === backendId,
      );
      if (!target) return;
      window.localStorage.setItem("codex-mobile:new-chat-backend", backendId);
      selectBackend(backendId);
      setCommand({
        id: ++commandIdRef.current,
        backendId,
        type: "new",
        cwd: null,
        draft: currentDraft,
        draftImages: currentDraftImages,
        draftFiles: currentDraftFiles,
      });
    },
    [mountedBackends, selectBackend],
  );

  if (!selectedBackend) {
    return <main className="app-shell"><div className="empty-state">{t("没有可用设备")}</div></main>;
  }

  return (
    <>
      {mountedBackends.map((backend) => (
        <div
          className="backend-workspace"
          hidden={backend.id !== selectedBackend.id}
          key={`${backend.id}:${backend.baseUrl}:${backend.token}`}
        >
          <BackendWorkspace
            backend={backend}
            conversationVisible={
              backend.id === selectedBackend.id && !sidebarOpen
            }
            backends={registry.backends}
            summaries={summaries}
            onSummaryChange={updateSummary}
            onSnapshotChange={updateSnapshot}
            onOpenSidebar={openSidebar}
            onSwitchNewChatBackend={switchNewChatBackend}
            command={command}
            refreshVersion={refreshVersion}
          />
        </div>
      ))}
      <div
        className={`conversation-sidebar-layer${
          sidebarOpen ? " open" : ""
        }`}
        aria-hidden={!sidebarOpen}
      >
        <aside className="conversation-sidebar" aria-label={t("会话列表")}>
          <ThreadListPage
            backends={registry.backends}
            summaries={summaries}
            selectedBackendId={listBackendId}
            loadingBackendIds={loadingBackendIds}
            refreshing={refreshing}
            threadListState={threadListState}
            visibleThreads={scopedThreads}
            totalThreadCount={scopedThreadCount}
            projectDirectories={projectDirectories}
            projectThreadStates={projectThreadStates}
            projectVisibleCounts={projectVisibleCounts}
            collapsedProjectKeys={collapsedProjectKeys}
            loadingProjectKeys={loadingProjectKeys}
            openingThreadId={openingThreadId}
            query={query}
            error={listError}
            onQueryChange={setQuery}
            onOpenThread={openThread}
            onNewChat={startNewChat}
            onSelectBackend={selectListBackend}
            onManageBackends={() => setManagerOpen(true)}
            onRefresh={refreshAllBackends}
            onToggleProject={toggleProject}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            onRetryProject={retryProject}
          />
        </aside>
        <button
          className="conversation-sidebar-scrim"
          type="button"
          aria-label={t("关闭会话列表")}
          onClick={closeSidebar}
        />
      </div>
      <BackendAttentionBanner
        backends={registry.backends}
        summaries={summaries}
        selectedBackendId={selectedBackend.id}
        onSelect={(backendId) => {
          selectBackend(backendId);
          selectListBackend(backendId);
          openSidebar();
        }}
      />
      <BackendManagerSheet
        open={managerOpen}
        registry={registry}
        summaries={summaries}
        onChange={persistRegistry}
        onClose={() => setManagerOpen(false)}
        appUpdate={{
          supported: appUpdate.supported,
          currentVersion: appUpdate.state.currentVersion,
          checking: appUpdate.state.phase === "checking",
          status:
            appUpdate.state.phase === "current"
              ? t("已是最新版本")
              : appUpdate.state.phase === "error"
                ? appUpdate.state.error
                : undefined,
          onCheck: () => void appUpdate.check(true),
        }}
      />
      <AppUpdateSheet
        open={appUpdate.sheetOpen}
        state={appUpdate.state}
        onClose={() => appUpdate.setSheetOpen(false)}
        onInstall={appUpdate.install}
        onRetry={appUpdate.install}
      />
    </>
  );
}
