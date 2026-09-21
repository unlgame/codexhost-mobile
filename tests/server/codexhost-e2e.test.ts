import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createGateway } from "../../server/gateway.js";
import { startCodexHostBridge } from "../../server/codexhost-bridge.js";

const DESCRIPTOR_FILE = "remote-control-bridge-v1.json";
const ACCESS_TOKEN = "e2e-token";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Frame {
  id?: unknown;
  method?: string;
  result?: unknown;
  params?: Record<string, unknown>;
}

function parseFrame(data: WebSocket.RawData): Frame {
  return JSON.parse(data.toString()) as Frame;
}

/** 假扮 codex-host：记录收到的每一帧，并按 method 应答。 */
async function startFakeHost(): Promise<{
  port: number;
  received: Frame[];
  send: (frame: Frame) => void;
  close: () => Promise<void>;
}> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const received: Frame[] = [];
  let host: WebSocket | null = null;
  wss.on("connection", (socket) => {
    host = socket;
    socket.on("message", (data) => {
      const frame = parseFrame(data);
      received.push(frame);
      if (frame.method === "initialize") {
        socket.send(JSON.stringify({ id: frame.id, result: { userAgent: "codex-host/fake" } }));
        return;
      }
      if (frame.method === "thread/start") {
        socket.send(
          JSON.stringify({ id: frame.id, result: { threadId: frame.params?.threadId ?? null } }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("假 Host 监听失败");
  return {
    port: address.port,
    received,
    send: (frame) => host?.send(JSON.stringify(frame)),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

async function writeDescriptor(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexhost-e2e-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const descriptorPath = join(directory, DESCRIPTOR_FILE);
  await writeFile(
    descriptorPath,
    JSON.stringify({
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: "\\\\.\\pipe\\codexhost-remote-control-1-e2e",
    }),
    "utf8",
  );
  return descriptorPath;
}

async function startStack(hostPort: number) {
  const descriptorPath = await writeDescriptor();
  const bridge = await startCodexHostBridge({
    descriptorPath,
    port: 0,
    environment: { LOCALAPPDATA: "C:\\Users\\ci\\AppData\\Local" },
    diagnosticOutput: (() => {
      const stream = new PassThrough();
      stream.resume();
      return stream;
    })(),
    createUpstreamConnection: () => createConnection(hostPort, "127.0.0.1"),
  });
  cleanups.push(() => bridge.close());

  const gateway = await createGateway({
    host: "127.0.0.1",
    port: 0,
    mode: "external",
    upstreamUrl: `ws://127.0.0.1:${bridge.port}`,
    staticDir: null,
    accessToken: ACCESS_TOKEN,
  });
  cleanups.push(() => gateway.close());
  return { gateway };
}

/** 模拟手机：连上网关 /ws，收集收到的帧。 */
async function connectPhone(
  gatewayPort: number,
  token: string = ACCESS_TOKEN,
): Promise<{ socket: WebSocket; frames: Frame[]; next: () => Promise<Frame> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws?token=${token}`);
  const frames: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];
  socket.on("message", (data) => {
    const frame = parseFrame(data);
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close();
      }),
  );
  return {
    socket,
    frames,
    next: () =>
      new Promise<Frame>((resolve) => {
        const queued = frames.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        waiters.push(resolve);
      }),
  };
}

describe("codexhost 端到端：手机 → 网关 → 小桥 → Host", () => {
  it("initialize 经小桥后 id 被还原，Host 收到的是改写后的 id", async () => {
    const host = await startFakeHost();
    cleanups.push(() => host.close());
    const { gateway } = await startStack(host.port);
    const phone = await connectPhone(gateway.port);

    phone.socket.send(
      JSON.stringify({ id: 7, method: "initialize", params: { clientInfo: { name: "phone" } } }),
    );
    const response = await phone.next();

    expect(response).toEqual({ id: 7, result: { userAgent: "codex-host/fake" } });
    // 小桥把下游 id 改写成 `c1:7`，Host 看到的必须是改写后的值。
    expect(host.received).toEqual([
      { id: "c1:7", method: "initialize", params: { clientInfo: { name: "phone" } } },
    ]);
  });

  it("thread/start 订阅后，Host 主动审批请求只送达订阅方且响应原样带回", async () => {
    const host = await startFakeHost();
    cleanups.push(() => host.close());
    const { gateway } = await startStack(host.port);
    const phone = await connectPhone(gateway.port);

    phone.socket.send(JSON.stringify({ id: 1, method: "thread/start", params: { threadId: "t-1" } }));
    expect((await phone.next()).result).toEqual({ threadId: "t-1" });

    // Host 主动发起审批请求：id 由 Host 生成，小桥不得改写。
    host.send({
      id: "host-approval-1",
      method: "item/commandApproval",
      params: { threadId: "t-1", command: "rm -rf build" },
    });
    expect(await phone.next()).toEqual({
      id: "host-approval-1",
      method: "item/commandApproval",
      params: { threadId: "t-1", command: "rm -rf build" },
    });

    phone.socket.send(JSON.stringify({ id: "host-approval-1", result: { approved: true } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.received.at(-1)).toEqual({ id: "host-approval-1", result: { approved: true } });
  });

  it("没有订阅该线程的第二台手机收不到 Host 主动请求", async () => {
    const host = await startFakeHost();
    cleanups.push(() => host.close());
    const { gateway } = await startStack(host.port);
    const subscriber = await connectPhone(gateway.port);
    const bystander = await connectPhone(gateway.port);

    subscriber.socket.send(
      JSON.stringify({ id: 1, method: "thread/start", params: { threadId: "t-9" } }),
    );
    await subscriber.next();

    host.send({ id: "q-1", method: "item/question", params: { threadId: "t-9" } });
    expect(await subscriber.next()).toMatchObject({ id: "q-1" });

    // 旁观者不该收到任何帧。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(bystander.frames).toEqual([]);
  });

  it("缺少或错误的访问口令时拒绝 WebSocket 升级", async () => {
    const host = await startFakeHost();
    cleanups.push(() => host.close());
    const { gateway } = await startStack(host.port);

    const rejected = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
    const error = await new Promise<Error>((resolve) => rejected.once("error", resolve));
    expect(error.message).toContain("Unexpected server response");

    const wrongToken = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws?token=nope`);
    const wrongError = await new Promise<Error>((resolve) =>
      wrongToken.once("error", resolve),
    );
    expect(wrongError.message).toContain("Unexpected server response");

    // 口令正确时仍然可用，证明拒绝不是把整个服务关掉。
    const phone = await connectPhone(gateway.port);
    phone.socket.send(JSON.stringify({ id: 3, method: "initialize", params: {} }));
    expect((await phone.next()).result).toEqual({ userAgent: "codex-host/fake" });
  });

  it("Host 断开后手机关闭（1011），不会静默丢会话", async () => {
    const host = await startFakeHost();
    const { gateway } = await startStack(host.port);
    const phone = await connectPhone(gateway.port);
    const closed = new Promise<{ code: number }>((resolve) =>
      phone.socket.once("close", (code) => resolve({ code })),
    );

    await host.close();
    cleanups.splice(cleanups.indexOf(host.close), 1);

    expect((await closed).code).toBe(1011);
  });
});
