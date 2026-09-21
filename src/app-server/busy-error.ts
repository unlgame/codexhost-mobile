/**
 * codex-host guards its official runtime with a single synchronous admission
 * boundary (`OfficialWorkGate`). A second client that arrives while another
 * device holds the gate is rejected with `OfficialAdmissionError`, whose message
 * is `Codex is busy`. We surface that as a toast and never retry or queue.
 */
export const BUSY_HINT = "另一台设备正在使用，请稍候";

/** Matches `Codex is busy` / `... is busy` style admission errors. */
export function isBusyError(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : reason && typeof reason === "object" && "message" in reason
          ? String((reason as { message?: unknown }).message ?? "")
          : "";
  return /\bbusy\b/iu.test(message);
}

/**
 * Returns the toast copy when the failure is an admission conflict, otherwise
 * `null` so callers keep their existing error handling.
 */
export function busyHintFor(reason: unknown): string | null {
  return isBusyError(reason) ? BUSY_HINT : null;
}
