import { AppServerClient } from "./client";
import { harnessRouteLabel, tryDecodeHarnessRoute } from "./harness-route";

export const HARNESS_PLUGINS_LIST_METHOD = "codexhost/harness/plugins/list";

/** One `model/list` entry that belongs to an external Harness. */
export interface HarnessModelOption {
  /** Raw `model` value. `turn/start` forwards it verbatim, never re-encoded. */
  model: string;
  harnessId: string;
  /** Model Ref carried inside the plugin route, when there is one. */
  routeModel?: string;
  description: string;
}

type ModelEntry = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Classify a `model/list` entry. Returns `null` for official Codex models so the
 * official group keeps its current behaviour untouched.
 *
 * codex-host marks external entries either with a `codexhost/plugin-v1@` route
 * in `model`, or with a `selectedHarness` field next to a transport model id
 * (`codexhost/<harness>-native@…`).
 */
export function harnessModelOptionFromEntry(entry: unknown): HarnessModelOption | null {
  const record = (typeof entry === "object" && entry !== null ? entry : {}) as ModelEntry;
  const model = text(record.model);
  if (!model) return null;
  const route = model.startsWith("codexhost/plugin-v1@")
    ? tryDecodeHarnessRoute(model)
    : null;
  const selectedHarness = text(record.selectedHarness);
  if (!route && !selectedHarness) return null;
  return {
    model,
    harnessId: route?.harnessId || selectedHarness,
    ...(route?.model ? { routeModel: route.model } : {}),
    description: text(record.description),
  };
}

/** Split a `model/list` payload into official entries and external Harness ones. */
export function splitModelCatalog(
  models: ReadonlyArray<unknown>,
): { official: unknown[]; harness: HarnessModelOption[] } {
  const official: unknown[] = [];
  const harness: HarnessModelOption[] = [];
  for (const entry of models) {
    const option =
      typeof entry === "object" && entry !== null
        ? harnessModelOptionFromEntry(entry as ModelEntry)
        : null;
    if (option) harness.push(option);
    else official.push(entry);
  }
  return { official, harness };
}

const pluginDisplayNames = new Map<string, string>();

/** In-memory cache of `codexhost/harness/plugins/list` display names. */
export async function loadHarnessPluginNames(
  client: AppServerClient | null | undefined,
): Promise<Map<string, string>> {
  if (!client) return pluginDisplayNames;
  try {
    const result = await client.request<{ plugins?: Array<{ id?: unknown; name?: unknown }> }>(
      HARNESS_PLUGINS_LIST_METHOD,
      {},
    );
    for (const plugin of result?.plugins ?? []) {
      const id = text(plugin?.id);
      const name = text(plugin?.name);
      if (id && name) pluginDisplayNames.set(id, name);
    }
  } catch {
    // Non-codexhost backends answer with an error: degrade to the raw harness id.
  }
  return pluginDisplayNames;
}

export function harnessPluginName(harnessId: string): string {
  return pluginDisplayNames.get(harnessId) ?? harnessId;
}

export function resetHarnessPluginNames(): void {
  pluginDisplayNames.clear();
}

/** `harness 显示名 · 路由内的 model`, falling back to the raw harness id. */
export function harnessModelLabel(
  option: HarnessModelOption,
  displayName?: string,
): string {
  return harnessRouteLabel(
    {
      harnessId: option.harnessId,
      ...(option.routeModel ? { model: option.routeModel } : {}),
    },
    displayName ?? harnessPluginName(option.harnessId),
  );
}
