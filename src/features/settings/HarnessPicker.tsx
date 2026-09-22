import { t } from "../../i18n";

export interface HarnessPluginOption {
  id: string;
  name: string;
}

/**
 * 官方 Codex 在列表里的 id。
 *
 * codex-host 把 `codex` 当作保留 id（`encodeHarnessRoute` 会拒绝它），所以
 * 「官方 Codex」**不是**一个 harnessId=codex 的路由，而是「不发路由」——
 * 也就是 thread/start 里带普通官方 model 的那条路。
 */
export const OFFICIAL_HARNESS_ID = "codex";

/**
 * 选择「用哪个 harness」。只做这一件事。
 *
 * 模型与思考档位统一由中间那个「智能」下拉框负责，并且跟着这里的选择变
 * （见 ComposerSettings）。之前把模型塞在这个面板里是错的：选了外部 harness
 * 之后中间那个模型框仍然只有官方模型，用户无法确定最终用的是什么模型，也
 * 退不回官方 Codex。
 */
export function HarnessPicker({
  plugins,
  selectedHarnessId,
  inspectError,
  onChooseHarness,
}: {
  plugins: HarnessPluginOption[];
  /** null 表示官方 Codex。 */
  selectedHarnessId: string | null;
  inspectError: string;
  onChooseHarness: (harnessId: string | null) => void;
}) {
  const entries = [
    { id: OFFICIAL_HARNESS_ID, name: t("官方 Codex"), official: true },
    ...plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      official: false,
    })),
  ];

  return (
    <>
      <div className="popover-eyebrow">{t("Harness")}</div>
      <div className="popover-options" aria-label={t("Harness 列表")}>
        {entries.map((entry) => {
          const selected = entry.official
            ? !selectedHarnessId
            : entry.id === selectedHarnessId;
          return (
            <button
              key={entry.id}
              className={selected ? "selected" : ""}
              aria-pressed={selected}
              onClick={() => onChooseHarness(entry.official ? null : entry.id)}
            >
              <span>
                <strong>{entry.name}</strong>
                {!entry.official && <small>{entry.id}</small>}
              </span>
              <i>{selected ? "✓" : ""}</i>
            </button>
          );
        })}
      </div>
      {inspectError && <div className="popover-empty">{inspectError}</div>}
    </>
  );
}
