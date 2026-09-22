import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("页面缩放约束", () => {
  it("禁止整体页面缩放，同时保留全面屏安全区域适配", () => {
    const viewport =
      html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)?.[1] ?? "";

    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("initial-scale=1");
    expect(viewport).toContain("maximum-scale=1");
    expect(viewport).toContain("user-scalable=no");
    expect(viewport).toContain("viewport-fit=cover");
  });

  it("声明软键盘压缩 layout viewport，别让 WebView 平移整个页面", () => {
    // Chrome 默认 resizes-visual：键盘只缩 visual viewport，100dvh 不变，
    // 底部 fixed 的输入框就落在键盘下面，WebView 会把页面整体上移——标题栏
    // 和侧边栏按钮随之被顶出屏幕。声明 resizes-content 才会真正压缩。
    const viewport =
      html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)?.[1] ?? "";

    expect(viewport).toContain("interactive-widget=resizes-content");
  });

  it("外壳高度用 --app-height 兜底，键盘收起时回落到 100dvh", () => {
    // 容器若没把 ime inset 传给渲染层（edge-to-edge + 只消费 systemBars 就会
    // 这样），光靠 viewport meta 不够，得由 src/ui/viewport-insets.ts 把可见区
    // 高度写进 --app-height。回退值必须是 100dvh，否则没有键盘时布局会变。
    expect(styles).toContain("height: var(--app-height, 100dvh)");
  });

  it("页面允许平移滚动但不把双指手势交给浏览器缩放", () => {
    const pageRule =
      styles.match(/html,\s*body\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(pageRule).toContain("touch-action: pan-x pan-y");
  });
});
