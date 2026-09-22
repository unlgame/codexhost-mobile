import type { AppServerClient } from "./client";

/**
 * 外部 harness 的数据来源。
 *
 * 这里**不**从 `model/list` 取 harness——codex-host 的 `model/list` 是纯透传，
 * 而且它明确删掉过给该响应追加 harness 条目的路径（归档决策：
 * `openspec/changes/archive/2026-07-27-implement-pi-model-routed-vertical-slice/
 * proposal.md`：「删除已证明不能驱动当前 Desktop picker 的生产 model/list/
 * 临时 Catalog 增强路径」）。所以 harness 列表来自 `harness/plugins/list`，
 * 模型/思考/权限来自 `harness/inspect`。
 *
 * 绑定时机也由 codex-host 定死：harness 只在 `thread/start` 时绑定
 * （`decodeCreateRoute` 要求 `request.method === "thread/start"`），会话中换
 * harness 会被 `-32602 "Turn Model carrier does not belong to the Thread
 * Harness"` 拒绝。会话中要改模型/思考/权限，得走下面三个 select RPC，并且受
 * `capabilities.configuration.*` 与 `permissionModeScope` 约束。
 */

export const HARNESS_INSPECT_METHOD = "codexhost/harness/inspect";
export const THREAD_INSPECT_METHOD = "codexhost/thread/inspect";
export const THREAD_MODEL_SELECT_METHOD = "codexhost/thread/model/select";
export const THREAD_THINKING_SELECT_METHOD = "codexhost/thread/thinking/select";
export const THREAD_PERMISSION_MODE_SELECT_METHOD =
  "codexhost/thread/permission-mode/select";

export interface HarnessModel {
  id: string;
  label: string;
  /** 该模型支持的思考档位；缺省表示不限制。 */
  thinkingOptionIds: string[];
}

export interface HarnessThinkingOption {
  id: string;
  label: string;
}

export interface HarnessPermissionMode {
  id: string;
  label: string;
  description?: string;
  dangerous?: boolean;
}

export interface HarnessCapabilities {
  selectModel: boolean;
  selectThinkingOption: boolean;
  selectPermissionMode: boolean;
  permissionModeScope: "live" | "atCreate";
}

export interface HarnessInspection {
  /** `ready` 之外都是不可用状态，`errorMessage` 里带上游原文。 */
  status: "ready" | "notInstalled" | "unavailable" | "error";
  errorMessage?: string;
  models: HarnessModel[];
  defaultModelId?: string;
  thinkingOptions: HarnessThinkingOption[];
  defaultThinkingOptionId?: string;
  permissionModes: HarnessPermissionMode[];
  defaultPermissionModeId?: string;
  capabilities: HarnessCapabilities;
}

const UNAVAILABLE_CAPABILITIES: HarnessCapabilities = {
  selectModel: false,
  selectThinkingOption: false,
  selectPermissionMode: false,
  permissionModeScope: "live",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function bool(value: unknown): boolean {
  return value === true;
}

/**
 * 解析 `codexhost/harness/inspect` 的响应。
 *
 * 上游 schema 很严（`.strict()`），但这里仍然逐字段取值而不是直接信：
 * 响应来自跨进程的 JSON-RPC，字段缺失或类型不对时应当退化成「不可用」，
 * 而不是让 picker 崩掉。
 */
export function parseHarnessInspection(payload: unknown): HarnessInspection {
  const root = record(payload);
  const status = text(root.status);
  if (status !== "ready") {
    return {
      status:
        status === "notInstalled" || status === "unavailable" || status === "error"
          ? status
          : "error",
      errorMessage: text(record(root.error).message) || undefined,
      models: [],
      thinkingOptions: [],
      permissionModes: [],
      capabilities: UNAVAILABLE_CAPABILITIES,
    };
  }

  const catalog = record(root.catalog);
  const models: HarnessModel[] = [];
  for (const entry of list(catalog.models)) {
    const item = record(entry);
    const id = text(record(item.ref).id);
    if (!id) continue;
    models.push({
      id,
      label: text(item.label) || id,
      thinkingOptionIds: list(item.supportedThinkingOptionIds)
        .map(text)
        .filter(Boolean),
    });
  }

  const thinkingOptions: HarnessThinkingOption[] = [];
  for (const entry of list(catalog.thinkingOptions)) {
    const item = record(entry);
    const id = text(item.id);
    if (!id) continue;
    thinkingOptions.push({ id, label: text(item.label) || id });
  }

  const permissionModes: HarnessPermissionMode[] = [];
  const modeCatalog = record(root.permissionModes);
  for (const entry of list(modeCatalog.modes)) {
    const item = record(entry);
    const id = text(item.id);
    if (!id) continue;
    const description = text(item.description);
    permissionModes.push({
      id,
      label: text(item.label) || id,
      ...(description ? { description } : {}),
      ...(item.dangerous === true ? { dangerous: true } : {}),
    });
  }

  const configuration = record(record(root.capabilities).configuration);
  const scope = text(configuration.permissionModeScope);

  return {
    status: "ready",
    models,
    ...(text(record(catalog.defaultModel).id)
      ? { defaultModelId: text(record(catalog.defaultModel).id) }
      : {}),
    thinkingOptions,
    ...(text(catalog.defaultThinkingOptionId)
      ? { defaultThinkingOptionId: text(catalog.defaultThinkingOptionId) }
      : {}),
    permissionModes,
    ...(text(modeCatalog.defaultModeId)
      ? { defaultPermissionModeId: text(modeCatalog.defaultModeId) }
      : {}),
    capabilities: {
      selectModel: bool(configuration.selectModel),
      selectThinkingOption: bool(configuration.selectThinkingOption),
      selectPermissionMode: bool(configuration.selectPermissionMode),
      permissionModeScope: scope === "atCreate" ? "atCreate" : "live",
    },
  };
}

export async function inspectHarness(
  client: Pick<AppServerClient, "request">,
  harnessId: string,
  cwd?: string | null,
): Promise<HarnessInspection> {
  const result = await client.request<unknown>(HARNESS_INSPECT_METHOD, {
    harnessId,
    ...(cwd ? { cwd } : {}),
  });
  return parseHarnessInspection(result);
}

/** 会话中改模型：`model` 在协议里是 `{ id }` 对象，不是裸字符串。 */
export async function selectThreadModel(
  client: Pick<AppServerClient, "request">,
  threadId: string,
  modelId: string,
) {
  await client.request(THREAD_MODEL_SELECT_METHOD, {
    threadId,
    model: { id: modelId },
  });
}

export async function selectThreadThinking(
  client: Pick<AppServerClient, "request">,
  threadId: string,
  thinkingOptionId: string,
) {
  await client.request(THREAD_THINKING_SELECT_METHOD, {
    threadId,
    thinkingOptionId,
  });
}

export async function selectThreadPermissionMode(
  client: Pick<AppServerClient, "request">,
  threadId: string,
  permissionModeId: string,
) {
  await client.request(THREAD_PERMISSION_MODE_SELECT_METHOD, {
    threadId,
    permissionModeId,
  });
}

export interface ThreadHarnessBinding {
  harnessId: string;
  /** 当前生效的模型 / 思考 / 权限，用来把 picker 的选中态对上。 */
  effectiveModelId?: string;
  effectiveThinkingOptionId?: string;
  effectivePermissionModeId?: string;
}

/**
 * 从 `codexhost/thread/inspect` 的响应里取出线程绑定的 harness。
 *
 * 官方线程回 `{ owner: "codex", locked: true }`，返回 null。这个值决定
 * `turn/start` 要不要带 `model`：带错会被上游以
 * -32602 "Turn Model carrier does not belong to the Thread Harness" 拒绝。
 *
 * 顺带带出生效的模型/思考/权限——打开一条已有的 harness 线程时，这三个值就是
 * picker 该显示的选中态，否则中间那个下拉框会是空的。
 */
export function threadHarnessBinding(
  payload: unknown,
): ThreadHarnessBinding | null {
  const root = record(payload);
  if (text(root.owner) !== "external") return null;
  const harnessId = text(root.harnessId);
  if (!harnessId) return null;
  const modelId = text(record(root.effectiveModel).id);
  const thinkingOptionId = text(root.effectiveThinkingOptionId);
  const permissionModeId = text(root.effectivePermissionModeId);
  return {
    harnessId,
    ...(modelId ? { effectiveModelId: modelId } : {}),
    ...(thinkingOptionId ? { effectiveThinkingOptionId: thinkingOptionId } : {}),
    ...(permissionModeId ? { effectivePermissionModeId: permissionModeId } : {}),
  };
}

/** 某个模型下可选的思考档位；模型没声明就是全量。 */
export function thinkingOptionsForModel(
  inspection: HarnessInspection,
  modelId: string | undefined,
): HarnessThinkingOption[] {
  const model = inspection.models.find((entry) => entry.id === modelId);
  if (!model || model.thinkingOptionIds.length === 0) {
    return inspection.thinkingOptions;
  }
  const allowed = new Set(model.thinkingOptionIds);
  return inspection.thinkingOptions.filter((option) => allowed.has(option.id));
}
