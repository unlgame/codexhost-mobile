import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import {
  applyRuntimeEnvironment,
  type AndroidWebViewBridge,
} from "./ui/runtime-environment";
import { watchViewportInsets } from "./ui/viewport-insets";
import "./styles.css";

const nativeBridge = (
  window as typeof window & { JsBridge?: AndroidWebViewBridge }
).JsBridge;

applyRuntimeEnvironment(
  document.documentElement,
  navigator.userAgent,
  nativeBridge,
);

// 软键盘补偿：把可见区高度和键盘高度写成 CSS 变量，见 viewport-insets.ts。
watchViewportInsets();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
