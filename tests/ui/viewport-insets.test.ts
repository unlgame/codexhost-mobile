import { describe, expect, it } from "vitest";
import {
  applyViewportInsets,
  computeViewportInsets,
} from "../../src/ui/viewport-insets";

describe("软键盘视口补偿", () => {
  it("键盘收起时不给 --app-height，让 CSS 回落到 100dvh", () => {
    expect(
      computeViewportInsets({
        layoutHeight: 800,
        visualHeight: 800,
        offsetTop: 0,
      }),
    ).toEqual({ keyboardInset: 0, appHeight: null });
  });

  it("键盘弹出且 layout viewport 不变时算出键盘高度与可见区高度", () => {
    // edge-to-edge 容器不 resize 窗口时的典型值：layout 仍是 800，
    // visual 只剩 500。
    expect(
      computeViewportInsets({
        layoutHeight: 800,
        visualHeight: 500,
        offsetTop: 0,
      }),
    ).toEqual({ keyboardInset: 300, appHeight: 500 });
  });

  it("visual viewport 被上移时从键盘高度里扣掉偏移", () => {
    // WebView 平移页面之后 offsetTop 会大于 0，那部分不是键盘遮住的，
    // 不扣掉会把输入框抬得过高。
    expect(
      computeViewportInsets({
        layoutHeight: 800,
        visualHeight: 500,
        offsetTop: 120,
      }),
    ).toEqual({ keyboardInset: 180, appHeight: 500 });
  });

  it("容器自己正确 resize 时补偿自动变成空操作", () => {
    // 补上 ime inset 处理、或 WebView 认了 resizes-content 之后就是这样：
    // layout 跟着缩，差值算出来是 0，不会和容器的行为打架。
    expect(
      computeViewportInsets({
        layoutHeight: 500,
        visualHeight: 500,
        offsetTop: 0,
      }),
    ).toEqual({ keyboardInset: 0, appHeight: null });
  });

  it("把结果写进 CSS 变量，键盘收起时移除 --app-height", () => {
    const style = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => style.set(name, value),
        removeProperty: (name: string) => {
          style.delete(name);
        },
      },
    } as unknown as HTMLElement;

    applyViewportInsets(root, {
      layoutHeight: 800,
      visualHeight: 500,
      offsetTop: 0,
    });
    expect(style.get("--keyboard-inset")).toBe("300px");
    expect(style.get("--app-height")).toBe("500px");

    applyViewportInsets(root, {
      layoutHeight: 800,
      visualHeight: 800,
      offsetTop: 0,
    });
    expect(style.get("--keyboard-inset")).toBe("0px");
    expect(style.has("--app-height")).toBe(false);
  });
});
