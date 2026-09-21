import type { AppServerClient } from "./client";

/**
 * codex-host emits `codexhost/thread/usage/updated` as a *signal* carrying only
 * `{ threadId }`; the snapshot itself is read back through
 * `codexhost/thread/usage/inspect`. Both calls fail on non-codexhost backends,
 * so every entry point here degrades silently instead of surfacing an error.
 */
export const CODEXHOST_THREAD_USAGE_UPDATED_METHOD = "codexhost/thread/usage/updated";
export const CODEXHOST_THREAD_USAGE_INSPECT_METHOD = "codexhost/thread/usage/inspect";

/** Mirrors `threadUsageSnapshotSchema` (all fields optional). */
export interface ThreadUsageFields {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  totalCostUsd: number | null;
  totalCredits: number | null;
  cacheHitRatePercent: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  contextUsagePercent: number | null;
  planFiveHourUsedPercent: number | null;
  planFiveHourResetsAtUnix: number | null;
  planSevenDayUsedPercent: number | null;
  planSevenDayResetsAtUnix: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Normalise an arbitrary usage payload. Returns `null` when there is no reliable
 * number at all, so callers can hide the entry point instead of rendering `—`.
 */
export function threadUsageFields(usage: unknown): ThreadUsageFields | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const fields: ThreadUsageFields = {
    inputTokens: numberOrNull(record.inputTokens),
    cachedInputTokens: numberOrNull(record.cachedInputTokens),
    cacheWriteInputTokens: numberOrNull(record.cacheWriteInputTokens),
    outputTokens: numberOrNull(record.outputTokens),
    reasoningOutputTokens: numberOrNull(record.reasoningOutputTokens),
    totalTokens: numberOrNull(record.totalTokens),
    totalCostUsd: numberOrNull(record.totalCostUsd),
    totalCredits: numberOrNull(record.totalCredits),
    cacheHitRatePercent: numberOrNull(record.cacheHitRatePercent),
    contextUsedTokens: numberOrNull(record.contextUsedTokens),
    contextWindowTokens: numberOrNull(record.contextWindowTokens),
    contextUsagePercent: numberOrNull(record.contextUsagePercent),
    planFiveHourUsedPercent: numberOrNull(record.planFiveHourUsedPercent),
    planFiveHourResetsAtUnix: numberOrNull(record.planFiveHourResetsAtUnix),
    planSevenDayUsedPercent: numberOrNull(record.planSevenDayUsedPercent),
    planSevenDayResetsAtUnix: numberOrNull(record.planSevenDayResetsAtUnix),
  };
  if (Object.values(fields).every((value) => value === null)) return null;
  if (
    fields.contextUsagePercent === null &&
    fields.contextUsedTokens !== null &&
    fields.contextWindowTokens !== null &&
    fields.contextWindowTokens > 0
  ) {
    fields.contextUsagePercent = clampPercent(
      (fields.contextUsedTokens / fields.contextWindowTokens) * 100,
    );
  } else if (fields.contextUsagePercent !== null) {
    fields.contextUsagePercent = clampPercent(fields.contextUsagePercent);
  }
  return fields;
}

function compactScaled(value: number, divisor: number): string {
  return String(Math.round((value / divisor) * 10) / 10);
}

/** `424.1k` / `7.6M` style; missing values render as an em dash. */
export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude < 1_000) return `${sign}${Math.round(magnitude)}`;
  if (magnitude < 1_000_000) {
    const scaled = compactScaled(magnitude, 1_000);
    if (Number(scaled) >= 1_000) return `${sign}${compactScaled(magnitude, 1_000_000)}M`;
    return `${sign}${scaled}k`;
  }
  if (magnitude < 1_000_000_000) {
    const scaled = compactScaled(magnitude, 1_000_000);
    if (Number(scaled) >= 1_000) return `${sign}${compactScaled(magnitude, 1_000_000_000)}B`;
    return `${sign}${scaled}M`;
  }
  return `${sign}${compactScaled(magnitude, 1_000_000_000)}B`;
}

/** `$0.000` style session cost estimate. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(3)}`;
}

/** `7.7%` style; one decimal, clamped to a sane range. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(Math.round(clampPercent(value) * 10) / 10).toFixed(1)}%`;
}

/**
 * Pull a baseline snapshot for one thread. Non-codexhost backends reject the
 * method, which is expected and silently ignored.
 */
export async function inspectThreadUsage(
  client: AppServerClient | null | undefined,
  threadId: string,
): Promise<ThreadUsageFields | null> {
  if (!client || !threadId) return null;
  try {
    const result = await client.request<{ usage?: unknown }>(
      CODEXHOST_THREAD_USAGE_INSPECT_METHOD,
      { threadId },
    );
    return threadUsageFields(result?.usage ?? null);
  } catch {
    return null;
  }
}

/** Normalise a `codexhost/thread/usage/updated` notification payload. */
export function threadUsageFromNotification(params: unknown): ThreadUsageFields | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  if (record.usage !== undefined) return threadUsageFields(record.usage);
  return null;
}
