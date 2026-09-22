import { Chevron } from "../../ui/icons";
import { t } from "../../i18n";
import {
  thinkingOptionsForModel,
  type HarnessInspection,
} from "../../app-server/harness-inspect";

export interface HarnessPluginOption {
  id: string;
  name: string;
}

/**
 * 外部 Harness 选择器。
 *
 * 与官方模型选择器**分开**，因为 codex-host 的约束就是这样：harness 只在
 * `thread/start` 时绑定，会话中换 harness 会被 -32602 拒绝。所以这个面板只在
 * 「尚未创建线程」时可用，选中之后整条链路的 model 都是那个 harness 的模型，
 * 与官方 model picker 是互斥的两条路。
 */
export function HarnessPicker({
  plugins,
  selectedHarnessId,
  harnessName,
  inspection,
  inspectError,
  selectedModelId,
  selectedThinkingId,
  selectedPermissionModeId,
  onChooseHarness,
  onChooseModel,
  onChooseThinking,
  onChoosePermissionMode,
  onBackToHarnessList,
}: {
  plugins: HarnessPluginOption[];
  selectedHarnessId: string | null;
  harnessName: string;
  inspection: HarnessInspection | null;
  inspectError: string;
  selectedModelId: string | null;
  selectedThinkingId: string | null;
  selectedPermissionModeId: string | null;
  onChooseHarness: (harnessId: string) => void;
  onChooseModel: (modelId: string) => void;
  onChooseThinking: (thinkingOptionId: string) => void;
  onChoosePermissionMode: (permissionModeId: string) => void;
  onBackToHarnessList: () => void;
}) {
  if (!selectedHarnessId) {
    return (
      <>
        <div className="popover-eyebrow">{t("外部 Harness")}</div>
        {plugins.length === 0 ? (
          <div className="popover-empty">{t("没有可用的外部 Harness")}</div>
        ) : (
          <div className="popover-options" aria-label={t("外部 Harness 列表")}>
            {plugins.map((plugin) => (
              <button key={plugin.id} onClick={() => onChooseHarness(plugin.id)}>
                <span>
                  <strong>{plugin.name}</strong>
                  <small>{plugin.id}</small>
                </span>
                <Chevron />
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  const ready = inspection?.status === "ready";
  const models = inspection?.models ?? [];
  const thinkingOptions = inspection
    ? thinkingOptionsForModel(inspection, selectedModelId ?? undefined)
    : [];
  const permissionModes = inspection?.permissionModes ?? [];

  return (
    <>
      <button className="popover-title" onClick={onBackToHarnessList}>
        <span>
          <strong>{harnessName}</strong>
          <small>{t("更换 Harness")}</small>
        </span>
        <Chevron direction="down" />
      </button>
      <div className="popover-divider" />
      {inspectError && <div className="popover-empty">{inspectError}</div>}
      {!inspectError && inspection && !ready && (
        <div className="popover-empty">
          {inspection.errorMessage || t("该 Harness 当前不可用")}
        </div>
      )}
      {!inspectError && ready && (
        <>
          {inspection!.capabilities.selectModel && models.length > 0 && (
            <>
              <div className="popover-eyebrow">{t("模型")}</div>
              <div className="popover-options" aria-label={t("Harness 模型列表")}>
                {models.map((model) => {
                  const selected = model.id === selectedModelId;
                  return (
                    <button
                      key={model.id}
                      className={selected ? "selected" : ""}
                      aria-pressed={selected}
                      onClick={() => onChooseModel(model.id)}
                    >
                      <span>
                        <strong>{model.label}</strong>
                      </span>
                      <i>{selected ? "✓" : ""}</i>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {inspection!.capabilities.selectThinkingOption &&
            thinkingOptions.length > 0 && (
              <>
                <div className="popover-divider" />
                <div className="popover-eyebrow">{t("思考档位")}</div>
                <div className="popover-options" aria-label={t("思考档位列表")}>
                  {thinkingOptions.map((option) => {
                    const selected = option.id === selectedThinkingId;
                    return (
                      <button
                        key={option.id}
                        className={selected ? "selected" : ""}
                        aria-pressed={selected}
                        onClick={() => onChooseThinking(option.id)}
                      >
                        <span>
                          <strong>{option.label}</strong>
                        </span>
                        <i>{selected ? "✓" : ""}</i>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          {inspection!.capabilities.selectPermissionMode &&
            permissionModes.length > 0 && (
              <>
                <div className="popover-divider" />
                <div className="popover-eyebrow">{t("权限模式")}</div>
                <div className="popover-options" aria-label={t("Harness 权限模式列表")}>
                  {permissionModes.map((mode) => {
                    const selected = mode.id === selectedPermissionModeId;
                    return (
                      <button
                        key={mode.id}
                        className={selected ? "selected" : ""}
                        aria-pressed={selected}
                        onClick={() => onChoosePermissionMode(mode.id)}
                      >
                        <span>
                          <strong>{mode.label}</strong>
                          {mode.description && <small>{mode.description}</small>}
                        </span>
                        <i>{selected ? "✓" : ""}</i>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
        </>
      )}
    </>
  );
}
