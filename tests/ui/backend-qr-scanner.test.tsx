import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { BackendManagerSheet } from "../../src/features/backends/BackendManagerSheet";
import type { BackendRegistry } from "../../src/backends/types";

// 摄像头扫码在 jsdom 里不可能真跑，用 mock 顶掉，
// 这样测的是「扫码结果怎么变成表单值」这条业务路径，
// 而不是 qr-scanner 库本身。
const startMock = vi.fn();
const destroyMock = vi.fn();
const scanImageMock = vi.fn();

vi.mock("qr-scanner", () => {
  class QrScanner {
    WORKER_PATH = "";
    constructor(
      _video: HTMLVideoElement,
      private onResult: (result: { data: string }) => void,
      _options?: unknown,
    ) {}
    async start() {
      startMock();
    }
    destroy() {
      destroyMock();
    }
    static async scanImage(file: File) {
      return scanImageMock(file);
    }
  }
  return { default: QrScanner };
});

// 空注册表才会渲染「新增设备」表单，扫码按钮只在表单里。
const emptyRegistry: BackendRegistry = {
  version: 1,
  selectedBackendId: "",
  backends: [],
};

function renderSheet(scanQrCode?: () => Promise<string>) {
  const onChange = vi.fn();
  render(
    <BackendManagerSheet
      open
      registry={emptyRegistry}
      summaries={{}}
      onChange={onChange}
      onClose={() => {}}
      probe={vi.fn()}
      scanQrCode={scanQrCode}
    />,
  );
  return { onChange };
}

const scanButton = () =>
  screen.getByRole("button", { name: "扫描网关二维码" });

describe("网关二维码扫码", () => {
  beforeEach(() => {
    startMock.mockReset();
    destroyMock.mockReset();
    scanImageMock.mockReset();
  });
  // vitest 没开 globals，@testing-library 的自动清理不会注册，
  // 不手动清的话上一个用例的 DOM 会留在 document 里，查询就会撞车。
  afterEach(() => {
    cleanup();
  });

  it("点击扫码按钮打开扫码面板并真的去起摄像头", async () => {
    renderSheet();
    fireEvent.click(scanButton());
    // 面板里独有的提示文案，用来确认面板确实展开了。
    expect(
      await screen.findByText("将另一台设备上的连接二维码放入框内"),
    ).toBeTruthy();
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("宿主注入 scanQrCode 时优先走注入实现，不起摄像头", async () => {
    const scanQrCode = vi
      .fn()
      .mockResolvedValue("http://192.168.100.8:4173/?token=abc123");
    renderSheet(scanQrCode);
    fireEvent.click(scanButton());
    await waitFor(() => expect(scanQrCode).toHaveBeenCalledTimes(1));
    // 注入路径不该碰摄像头。
    expect(startMock).not.toHaveBeenCalled();
    // 扫到的地址要回填进输入框。
    await waitFor(() =>
      expect(screen.getByLabelText("网关地址").getAttribute("value")).toBe(
        "http://192.168.100.8:4173/?token=abc123",
      ),
    );
  });

  it("二维码里没有 token 时给出可读错误", async () => {
    const scanQrCode = vi
      .fn()
      .mockResolvedValue("http://192.168.100.8:4173/");
    renderSheet(scanQrCode);
    fireEvent.click(scanButton());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "二维码中缺少访问口令",
      ),
    );
  });

  it("注入扫码抛错时把原因显示出来，不静默失败", async () => {
    const scanQrCode = vi.fn().mockRejectedValue(new Error("相机被占用"));
    renderSheet(scanQrCode);
    fireEvent.click(scanButton());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("相机被占用"),
    );
  });

  it("从相册选图能识别二维码并回填", async () => {
    scanImageMock.mockResolvedValue({
      data: "http://192.168.100.8:4173/?token=from-photo",
    });
    renderSheet();
    fireEvent.click(scanButton());
    expect(
      await screen.findByText("将另一台设备上的连接二维码放入框内"),
    ).toBeTruthy();
    const fileInput = document.querySelector(
      ".gateway-qr-file input",
    ) as HTMLInputElement;
    const file = new File(["fake"], "qr.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByLabelText("网关地址").getAttribute("value")).toBe(
        "http://192.168.100.8:4173/?token=from-photo",
      ),
    );
    // 面板要在识别成功后自己收起来。
    await waitFor(() =>
      expect(
        screen.queryByText("将另一台设备上的连接二维码放入框内"),
      ).toBeNull(),
    );
  });

  it("相册图片识别失败时提示换一张，而不是静默无反应", async () => {
    scanImageMock.mockRejectedValue(new Error("no qr"));
    renderSheet();
    fireEvent.click(scanButton());
    expect(
      await screen.findByText("将另一台设备上的连接二维码放入框内"),
    ).toBeTruthy();
    const fileInput = document.querySelector(
      ".gateway-qr-file input",
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["fake"], "qr.png", { type: "image/png" })] },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "未识别到二维码，请换一张图片",
      ),
    );
  });

  it("关闭面板时销毁摄像头，不残留占用", async () => {
    renderSheet();
    fireEvent.click(scanButton());
    expect(
      await screen.findByText("将另一台设备上的连接二维码放入框内"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭扫码" }));
    await waitFor(() => expect(destroyMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByText("将另一台设备上的连接二维码放入框内"),
      ).toBeNull(),
    );
  });
});
