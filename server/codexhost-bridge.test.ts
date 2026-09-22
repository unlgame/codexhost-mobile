import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startCodexHostBridge } from "./codexhost-bridge.js";

const DESCRIPTOR_FILE = "remote-control-bridge-v1.json";
const PIPE_PREFIX = "\\\\.\\pipe\\codexhost-remote-control-";
const DEAD_PID = 999999;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface FakeHost {
  port: number;
  connections: WebSocket[];
  /** 小桥是懒拨号：只有第一个下游到来后才会连上这里。 */
  hostSocket: Promise<WebSocket>;
  close: () => Promise<void>;
}

/** 假扮 codex-host：在普通 TCP 端口上监听 WebSocket，由小桥注入的连接接入。 */
async function startFakeHost(): Promise<FakeHost> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const connections: WebSocket[] = [];
  let resolveSocket: (socket: WebSocket) => void = () => {};
  const hostSocket = new Promise<WebSocket>((resolve) => {
    resolveSocket = resolve;
  });
  wss.on("connection", (socket) => {
    connections.push(socket);
    resolveSocket(socket);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("假上游监听失败");
  return {
    port: address.port,
    connections,
    hostSocket,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

async function createDescriptorDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexhost-bridge-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeDescriptor(
  directory: string,
  descriptor: Record<string, unknown>,
): Promise<string> {
  const descriptorPath = join(directory, DESCRIPTOR_FILE);
  await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
  return descriptorPath;
}

function silentDiagnostics(): PassThrough {
  const stream = new PassThrough();
  stream.resume();
  return stream;
}

async function startBridge(
  descriptorPath: string,
  fakeHost: FakeHost,
  overrides: { keepUpstreamWhenIdle?: boolean } = {},
) {
  const bridge = await startCodexHostBridge({
    descriptorPath,
    port: 0,
    environment: { LOCALAPPDATA: "C:\\Users\\ci\\AppData\\Local" },
    diagnosticOutput: silentDiagnostics(),
    keepUpstreamWhenIdle: overrides.keepUpstreamWhenIdle,
    createUpstreamConnection: () => createConnection(fakeHost.port, "127.0.0.1"),
  });
  cleanups.push(() => bridge.close());
  return bridge;
}

async function connectDownstream(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
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
  return socket;
}

/** 收集中间帧，便于断言"某个客户端不该收到这条消息"。 */
function record(socket: WebSocket): string[] {
  const frames: string[] = [];
  socket.on("message", (data) => frames.push(data.toString()));
  return frames;
}

function closedCode(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

async function waitFor(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("codexhost 小桥 descriptor 校验", () => {
  it("descriptor 缺失时给出中文提示", async () => {
    const directory = await createDescriptorDirectory();
    await expect(
      startCodexHostBridge({
        descriptorPath: join(directory, "missing.json"),
        environment: { LOCALAPPDATA: "C:\\Users\\ci\\AppData\\Local" },
        diagnosticOutput: silentDiagnostics(),
      }),
    ).rejects.toThrow("未找到 codex-host 桥接描述文件");
  });

  it("LOCALAPPDATA 缺失或不是绝对路径时提示仅 Windows 可用", async () => {
    await expect(
      startCodexHostBridge({
        environment: {},
        diagnosticOutput: silentDiagnostics(),
      }),
    ).rejects.toThrow("仅在 Windows 上可用");
    await expect(
      startCodexHostBridge({
        environment: { LOCALAPPDATA: "relative/path" },
        diagnosticOutput: silentDiagnostics(),
      }),
    ).rejects.toThrow("仅在 Windows 上可用");
  });

  it("schemaVersion 不受支持时提示升级", async () => {
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 2,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}abc`,
    });
    await expect(
      startCodexHostBridge({
        descriptorPath,
        environment: { LOCALAPPDATA: "C:\\Users\\ci\\AppData\\Local" },
        diagnosticOutput: silentDiagnostics(),
      }),
    ).rejects.toThrow("schemaVersion=2");
  });

  it("pipePath 非法时拒绝启动", async () => {
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: "not-a-pipe",
    });
    await expect(
      startCodexHostBridge({
        descriptorPath,
        environment: { LOCALAPPDATA: "C:\\Users\\ci\\AppData\\Local" },
        diagnosticOutput: silentDiagnostics(),
      }),
    ).rejects.toThrow("pipePath");
  });

  it("owner 进程未运行时拒绝启动", async () => {
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: DEAD_PID,
      pipePath: `${PIPE_PREFIX}abc`,
    });
    await expect(
      startCodexHostBridge({
        descriptorPath,
        environment: { LOCALAPPDATA: "C:\\Users\\ci\\AppData\\Local" },
        diagnosticOutput: silentDiagnostics(),
      }),
    ).rejects.toThrow(`codex-host Host Runtime 未运行（pid=${DEAD_PID}）`);
  });
});

describe("codexhost 小桥多路复用", () => {
  it("改写并还原请求 id，只把响应发给原客户端", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-1`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);
    expect(bridge.port).toBeGreaterThan(0);

    const clientA = await connectDownstream(bridge.port);
    const clientB = await connectDownstream(bridge.port);
    // 懒拨号：两个下游只对应一条上游连接。
    const hostSocket = await fakeHost.hostSocket;
    const hostFrames: string[] = [];
    hostSocket.on("message", (data) => hostFrames.push(data.toString()));
    const framesA = record(clientA);
    const framesB = record(clientB);

    clientA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "thread/start",
        params: { threadId: "thread-1" },
      }),
    );
    await waitFor(() => hostFrames.length === 1);
    expect(fakeHost.connections).toHaveLength(1);
    const forwarded = JSON.parse(hostFrames[0]);
    expect(forwarded.id).toBe("c1:7");
    expect(forwarded.method).toBe("thread/start");

    hostSocket.send(
      JSON.stringify({ jsonrpc: "2.0", id: "c1:7", result: { thread: { id: "thread-1" } } }),
    );
    await waitFor(() => framesA.length === 1);
    expect(JSON.parse(framesA[0]).id).toBe(7);
    expect(framesB).toEqual([]);

    // 未知 id 的响应走广播兜底。
    hostSocket.send(JSON.stringify({ jsonrpc: "2.0", id: "ghost", result: {} }));
    await waitFor(() => framesA.length === 2 && framesB.length === 1);
    expect(JSON.parse(framesB[0]).id).toBe("ghost");
  });

  it("通知按 threadId 扇出，无 threadId 时广播", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-2`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);

    const clientA = await connectDownstream(bridge.port);
    const clientB = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    const hostFrames: string[] = [];
    hostSocket.on("message", (data) => hostFrames.push(data.toString()));
    const framesA = record(clientA);
    const framesB = record(clientB);

    clientA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "a-1",
        method: "thread/start",
        params: { threadId: "thread-1" },
      }),
    );
    clientB.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "b-1",
        method: "thread/read",
        params: { threadId: "thread-2" },
      }),
    );
    await waitFor(() => hostFrames.length === 2);

    hostSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/updated",
        params: { threadId: "thread-1", item: { id: "item-1" } },
      }),
    );
    await waitFor(() => framesA.length === 1);
    expect(JSON.parse(framesA[0]).params.threadId).toBe("thread-1");
    expect(framesB).toEqual([]);

    hostSocket.send(JSON.stringify({ jsonrpc: "2.0", method: "server/notice", params: {} }));
    await waitFor(() => framesA.length === 2 && framesB.length === 1);
    expect(JSON.parse(framesB[0]).method).toBe("server/notice");
  });

  it("thread/start 参数里没有 threadId，订阅从响应里的 thread.id 补登记", async () => {
    // 真实的 thread/start 参数里没有 threadId——线程此刻还不存在——所以只靠
    // 请求参数永远登记不上订阅。漏了这一步，新建线程的后续通知就只剩广播
    // 兜底，多台设备同时连时会把无关帧投给所有客户端。
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-start`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);

    const clientA = await connectDownstream(bridge.port);
    const clientB = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    const hostFrames: string[] = [];
    hostSocket.on("message", (data) => hostFrames.push(data.toString()));
    const framesA = record(clientA);
    const framesB = record(clientB);

    clientA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "a-1",
        method: "thread/start",
        params: { cwd: "C:/work" },
      }),
    );
    await waitFor(() => hostFrames.length === 1);
    const startFrame = JSON.parse(hostFrames[0]);
    hostSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: startFrame.id,
        result: { thread: { id: "thread-new" } },
      }),
    );
    await waitFor(() => framesA.length === 1);
    expect(JSON.parse(framesA[0]).id).toBe("a-1");

    hostSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: { threadId: "thread-new", threadName: "新名字" },
      }),
    );
    await waitFor(() => framesA.length === 2);
    expect(JSON.parse(framesA[1]).params.threadName).toBe("新名字");
    expect(framesB).toEqual([]);
  });

  it("Host 主动请求路由到线程操作方，响应原样带回", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-3`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);

    const clientA = await connectDownstream(bridge.port);
    const clientB = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    const hostFrames: string[] = [];
    hostSocket.on("message", (data) => hostFrames.push(data.toString()));
    const framesA = record(clientA);
    const framesB = record(clientB);

    clientA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "thread/start",
        params: { threadId: "thread-1" },
      }),
    );
    await waitFor(() => hostFrames.length === 1);

    hostSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "approval-1",
        method: "execCommandApproval",
        params: { threadId: "thread-1", command: ["ls"] },
      }),
    );
    await waitFor(() => framesA.length === 1);
    expect(JSON.parse(framesA[0]).id).toBe("approval-1");
    expect(framesB).toEqual([]);

    clientA.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "approval-1",
        result: { decision: "approved" },
      }),
    );
    await waitFor(() => hostFrames.length === 2);
    expect(JSON.parse(hostFrames[1]).id).toBe("approval-1");
  });

  it("下游二进制帧被 1003 关闭，无法解析的帧被跳过", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-4`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);

    const clientA = await connectDownstream(bridge.port);
    const clientB = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    const hostFrames: string[] = [];
    hostSocket.on("message", (data) => hostFrames.push(data.toString()));
    const framesA = record(clientA);
    record(clientB);
    const binaryClose = closedCode(clientB);

    clientA.send("这不是 JSON");
    clientA.send(JSON.stringify({ jsonrpc: "2.0", method: "thread/list", params: {} }));
    await waitFor(() => hostFrames.length === 1);
    expect(JSON.parse(hostFrames[0]).method).toBe("thread/list");
    expect(framesA).toEqual([]);

    clientB.send(Buffer.from([0x01, 0x02, 0x03]), { binary: true });
    expect(await binaryClose).toBe(1003);
  });

  it("上游断开后关闭全部下游（1011）", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-5`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);

    const clientA = await connectDownstream(bridge.port);
    const clientB = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    record(clientA);
    record(clientB);
    const closedA = closedCode(clientA);
    const closedB = closedCode(clientB);

    hostSocket.close();
    expect(await closedA).toBe(1011);
    expect(await closedB).toBe(1011);
  });

  it("端口 0 时自动挑选端口，且 close() 幂等", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-6`,
    });
    const first = await startBridge(descriptorPath, fakeHost);
    const second = await startBridge(descriptorPath, fakeHost);
    expect(first.port).toBeGreaterThan(0);
    expect(second.port).not.toBe(first.port);

    const client = await connectDownstream(first.port);
    const closed = closedCode(client);
    record(client);
    await first.close();
    await first.close();
    expect(await closed).toBe(1001);
    await expect(connectDownstream(first.port)).rejects.toThrow();
    await second.close();
  });

  it("下游全部断开且 keepUpstreamWhenIdle=false 时关闭上游", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-7`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost, {
      keepUpstreamWhenIdle: false,
    });

    const client = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    record(client);
    const hostClosed = new Promise<void>((resolve) => {
      hostSocket.once("close", () => resolve());
    });
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      client.close();
    });
    await hostClosed;
    await bridge.close();
  });

  it("默认在下游全部断开后保留上游会话", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-8`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);

    const client = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    record(client);
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      client.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hostSocket.readyState).toBe(WebSocket.OPEN);
    await bridge.close();
  });

  it("多个下游订阅同一线程时，Host 主动请求广播但只接受第一个响应", async () => {
    const fakeHost = await startFakeHost();
    cleanups.push(() => fakeHost.close());
    const directory = await createDescriptorDirectory();
    const descriptorPath = await writeDescriptor(directory, {
      schemaVersion: 1,
      ownerPid: process.pid,
      pipePath: `${PIPE_PREFIX}session-5`,
    });
    const bridge = await startBridge(descriptorPath, fakeHost);

    const clientA = await connectDownstream(bridge.port);
    const clientB = await connectDownstream(bridge.port);
    const hostSocket = await fakeHost.hostSocket;
    const hostFrames: string[] = [];
    hostSocket.on("message", (data) => hostFrames.push(data.toString()));
    const framesA = record(clientA);
    const framesB = record(clientB);

    for (const client of [clientA, clientB]) {
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "thread/start",
          params: { threadId: "thread-shared" },
        }),
      );
    }
    await waitFor(() => hostFrames.length === 2);

    hostSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "approval-shared",
        method: "execCommandApproval",
        params: { threadId: "thread-shared", command: ["ls"] },
      }),
    );
    await waitFor(() => framesA.length === 1 && framesB.length === 1);

    // 两个客户端都能看到审批请求。
    expect(JSON.parse(framesA[0]).id).toBe("approval-shared");
    expect(JSON.parse(framesB[0]).id).toBe("approval-shared");

    // 只有第一个响应会转发给 Host，重复响应被丢弃。
    clientB.send(
      JSON.stringify({ jsonrpc: "2.0", id: "approval-shared", result: { decision: "denied" } }),
    );
    await waitFor(() => hostFrames.length === 3);
    clientA.send(
      JSON.stringify({ jsonrpc: "2.0", id: "approval-shared", result: { decision: "approved" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(hostFrames.length).toBe(3);
    expect(JSON.parse(hostFrames[2]).result.decision).toBe("denied");
  });
});
