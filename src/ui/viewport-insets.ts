/**
 * 软键盘补偿。
 *
 * 这个 App 跑在 PakePlus 的 Android WebView 里，容器开了 edge-to-edge：
 * `enableEdgeToEdge()` 让窗口不再随软键盘 resize，而原生侧只消费了
 * `systemBars()`、没有消费 `ime()` inset。于是键盘弹出时会发生两件事：
 *
 *   1. layout viewport 不变 → `100dvh` 不缩水 → `position: fixed; bottom: 0`
 *      的输入框仍落在键盘下面；
 *   2. WebView 为了让聚焦的输入框露出来，把整个 visual viewport 上移 →
 *      标题栏、侧边栏按钮被顶出屏幕上方，下方留出一片空白。
 *
 * 这里把两件事写成 CSS 变量，让外壳按「可见区」排版、底部悬浮元素抬到键盘之上，
 * 第 2 步的平移就不再需要发生：
 *
 *   --app-height      可见区高度。只在键盘弹出时设置，收起时移除，让 CSS 回落
 *                     到 100dvh——常规路径一个像素都不变。
 *   --keyboard-inset  键盘遮住的高度，始终设置（收起时为 0）。
 *
 * 如果容器以后开始正确 resize（比如补上了 ime inset 处理，或者 WebView 认了
 * viewport meta 的 interactive-widget=resizes-content），layout viewport 会
 * 跟着缩，算出来的 keyboardInset 自然是 0、appHeight 为 null，这里自动变成
 * 空操作，不会和容器的行为打架。
 */

export interface ViewportMetrics {
  /** layout viewport 高度，即 documentElement.clientHeight。 */
  layoutHeight: number;
  /** visual viewport 高度，即当前真正可见的高度。 */
  visualHeight: number;
  /** visual viewport 相对 layout viewport 的上移量。 */
  offsetTop: number;
}

export interface ViewportInsets {
  /** 键盘遮住的高度，收起时为 0。 */
  keyboardInset: number;
  /** 键盘弹出时要用的外壳高度；收起时为 null，表示交回给 CSS 的 100dvh。 */
  appHeight: number | null;
}

export function computeViewportInsets(metrics: ViewportMetrics): ViewportInsets {
  const keyboardInset = Math.max(
    0,
    Math.round(metrics.layoutHeight - metrics.visualHeight - metrics.offsetTop),
  );
  return {
    keyboardInset,
    appHeight: keyboardInset > 0 ? Math.round(metrics.visualHeight) : null,
  };
}

export function applyViewportInsets(
  root: HTMLElement,
  metrics: ViewportMetrics,
): ViewportInsets {
  const insets = computeViewportInsets(metrics);
  root.style.setProperty("--keyboard-inset", `${insets.keyboardInset}px`);
  if (insets.appHeight === null) {
    root.style.removeProperty("--app-height");
  } else {
    root.style.setProperty("--app-height", `${insets.appHeight}px`);
  }
  return insets;
}

/**
 * 持续跟踪视口变化，返回取消订阅的函数。
 *
 * 必须同时监听 visualViewport 的 resize 与 scroll：键盘弹出时浏览器可能只移动
 * visual viewport（offsetTop 变化）而不改变它的高度，只看 resize 会漏掉。
 */
export function watchViewportInsets(
  root: HTMLElement = document.documentElement,
  win: Window = window,
): () => void {
  const viewport = win.visualViewport;
  const update = () => {
    applyViewportInsets(root, {
      layoutHeight: root.clientHeight,
      visualHeight: viewport?.height ?? win.innerHeight,
      offsetTop: viewport?.offsetTop ?? 0,
    });
  };

  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  win.addEventListener("resize", update);
  win.addEventListener("orientationchange", update);

  return () => {
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    win.removeEventListener("resize", update);
    win.removeEventListener("orientationchange", update);
  };
}
