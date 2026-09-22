import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type { Writable } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { resolveCodexHostBridgePort } from "./app-server-manager.js";

export interface CodexHostBridgeOptions {
  /** 覆盖 descriptor 路径，测试与非常规安装使用。 */
  descriptorPath?: string;
  /** 下游监听地址，默认仅监听回环地址。 */
  host?: string;
  /** 下游监听端口，0 表示由系统自动挑选。 */
  port?: number;
  environment?: NodeJS.ProcessEnv;
  diagnosticOutput?: Writable;
  /** 下游全部断开后是否保留上游连接，默认保留（保留会话）。 */
  keepUpstreamWhenIdle?: boolean;
  /** 测试注入：用普通 TCP 连接替代命名管道连接。 */
  createUpstreamConnection?: (pipePath: string) => Socket;
}

export interface CodexHostBridge {
  port: number;
  close(): Promise<void>;
}

interface RemoteControlDescriptor {
  schemaVersion?: unknown;
  ownerPid?: unknown;
  pipePath?: unknown;
}

interface DownstreamClient {
  id: string;
  socket: WebSocket;
  threads: Set<string>;
}

interface PendingRequest {
  client: DownstreamClient;
  originalId: unknown;
  /** 请求方法。thread/start 的订阅只能在响应里补登记，需要它来判别。 */
  method: string;
}

const DESCRIPTOR_DIRECTORY = "codexhost";
const DESCRIPTOR_FILE = "remote-control-bridge-v1.json";
const PIPE_PREFIX = "\\\\.\\pipe\\codexhost-remote-control-";
const UPSTREAM_URL = "ws://localhost/";
const DEFAULT_HOST = "127.0.0.1";
const THREAD_SUBSCRIPTION_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/items/list",
  // 改名要登记：否则改名后的 thread/name/updated 会走广播兜底，
  // 多台设备同时连时投给一堆无关客户端。
  "thread/name/set",
]);
const MAX_QUEUED_UPSTREAM_FRAMES = 512;
const MAX_QUEUED_UPSTREAM_BYTES = 8 * 1024 * 1024;
const UPSTREAM_CLOSE_REASON = "codex-host 连接断开";
const DOWNSTREAM_CLOSE_REASON = "codexhost 小桥已关闭";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function rawDataToString(data: WebSocket.Data): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function rawDataByteLength(data: string | Buffer | ArrayBuffer): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

function extractThreadId(message: Record<string, unknown>): string | null {
  const params = message.params;
  if (!isRecord(params)) return null;
  return typeof params.threadId === "string" && params.threadId ? params.threadId : null;
}

function describeDescriptorPath(
  environment: NodeJS.ProcessEnv,
  override?: string,
): string {
  if (override) return override;
  const root = environment.LOCALAPPDATA;
  if (!root || !isAbsolutePath(root)) {
    throw new Error(
      "codexhost 模式仅在 Windows 上可用：未找到 %LOCALAPPDATA% 目录，" +
        `无法读取 ${DESCRIPTOR_DIRECTORY}/${DESCRIPTOR_FILE}`,
    );
  }
  return join(win32.normalize(root), DESCRIPTOR_DIRECTORY, DESCRIPTOR_FILE);
}

async function readRemoteControlDescriptor(
  environment: NodeJS.ProcessEnv,
  override?: string,
): Promise<{ ownerPid: number; pipePath: string }> {
  const descriptorPath = describeDescriptorPath(environment, override);
  let raw: string;
  try {
    raw = await readFile(descriptorPath, "utf8");
  } catch {
    throw new Error(
      `未找到 codex-host 桥接描述文件，请确认 codex-host 正在运行（${descriptorPath}）`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `未找到 codex-host 桥接描述文件，请确认 codex-host 正在运行（${descriptorPath} 解析失败）`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `未找到 codex-host 桥接描述文件，请确认 codex-host 正在运行（${descriptorPath} 内容无效）`,
    );
  }
  const descriptor = parsed as RemoteControlDescriptor;
  if (descriptor.schemaVersion !== 1) {
    throw new Error(
      `codex-host 桥接描述不受支持（schemaVersion=${String(descriptor.schemaVersion)}），` +
        "请升级 codexhost-mobile",
    );
  }
  const { ownerPid } = descriptor;
  if (typeof ownerPid !== "number" || !Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new Error(`codex-host 桥接描述中的 ownerPid 无效（${String(ownerPid)}）`);
  }
  const { pipePath } = descriptor;
  if (typeof pipePath !== "string" || !pipePath.startsWith(PIPE_PREFIX)) {
    throw new Error(`codex-host 桥接描述中的 pipePath 无效（${String(pipePath)}）`);
  }
  // 绝不自行拼接管道名：只使用 descriptor 发布的 pipePath。
  return { ownerPid, pipePath };
}

function assertOwnerRunning(ownerPid: number): void {
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM 表示进程存在但当前用户无权发信号，按存活处理。
    if (code === "EPERM") return;
    throw new Error(`codex-host Host Runtime 未运行（pid=${ownerPid}）`);
  }
}

export async function startCodexHostBridge(
  options: CodexHostBridgeOptions = {},
): Promise<CodexHostBridge> {
  const environment = options.environment ?? process.env;
  const diagnostics = options.diagnosticOutput ?? process.stderr;
  const diagnose = (message: string): void => {
    diagnostics.write(`codexhost 小桥：${message}\n`);
  };

  const descriptor = await readRemoteControlDescriptor(environment, options.descriptorPath);
  assertOwnerRunning(descriptor.ownerPid);

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? resolveCodexHostBridgePort(environment);
  const keepUpstreamWhenIdle = options.keepUpstreamWhenIdle ?? true;
  const openUpstreamConnection =
    options.createUpstreamConnection ?? ((pipePath: string) => createConnection(pipePath));

  const clients = new Map<string, DownstreamClient>();
  const subscriptions = new Map<string, Set<DownstreamClient>>();
  const pending = new Map<string, PendingRequest>();
  const hostRequests = new Map<string, Set<string>>();
  /** 已收到回复的 Host 主动请求：用于丢弃其余客户端的重复响应。 */
  const resolvedHostRequests = new Set<string>();
  const queued: Array<{ data: string | Buffer | ArrayBuffer; binary: boolean }> = [];
  let queuedBytes = 0;
  let nextClientId = 0;
  let upstream: WebSocket | null = null;
  let dialing: Promise<void> | null = null;
  let closing = false;

  const deliver = (client: DownstreamClient, frame: string): void => {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(frame);
  };

  const broadcast = (frame: string): void => {
    for (const client of clients.values()) deliver(client, frame);
  };

  const subscribersOf = (threadId: string | null): DownstreamClient[] => {
    if (!threadId) return [];
    return [...(subscriptions.get(threadId) ?? [])].filter((client) =>
      clients.has(client.id),
    );
  };

  const forgetPendingRequests = (client: DownstreamClient): void => {
    for (const [rewrittenId, entry] of pending) {
      if (entry.client === client) pending.delete(rewrittenId);
    }
  };

  const removeClient = (client: DownstreamClient): void => {
    if (!clients.delete(client.id)) return;
    for (const threadId of client.threads) {
      subscriptions.get(threadId)?.delete(client);
      if (subscriptions.get(threadId)?.size === 0) subscriptions.delete(threadId);
    }
    for (const [requestId, awaiting] of hostRequests) {
      awaiting.delete(client.id);
      if (awaiting.size === 0) {
        hostRequests.delete(requestId);
        resolvedHostRequests.delete(requestId);
      }
    }
    client.threads.clear();
    forgetPendingRequests(client);
    if (clients.size === 0 && !keepUpstreamWhenIdle && upstream) {
      upstream.close(1000, DOWNSTREAM_CLOSE_REASON);
    }
  };

  const closeAllDownstreams = (code: number, reason: string): void => {
    for (const client of [...clients.values()]) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.close(code, reason);
      else if (client.socket.readyState === WebSocket.CONNECTING) client.socket.terminate();
    }
  };

  const registerThreadSubscription = (
    client: DownstreamClient,
    threadId: string,
  ): void => {
    if (client.threads.has(threadId)) return;
    client.threads.add(threadId);
    const subscribers = subscriptions.get(threadId) ?? new Set<DownstreamClient>();
    subscribers.add(client);
    subscriptions.set(threadId, subscribers);
  };

  const trackThreadActivity = (
    client: DownstreamClient,
    message: Record<string, unknown>,
  ): void => {
    const threadId = extractThreadId(message);
    if (!threadId) return;
    if (typeof message.method === "string" && THREAD_SUBSCRIPTION_METHODS.has(message.method)) {
      registerThreadSubscription(client, threadId);
    }
  };

  const flushQueued = (socket: WebSocket): void => {
    while (queued.length > 0 && socket.readyState === WebSocket.OPEN) {
      const frame = queued.shift();
      if (!frame) break;
      queuedBytes -= rawDataByteLength(frame.data);
      try {
        socket.send(frame.data, { binary: frame.binary });
      } catch (error) {
        diagnose(`向上游转发积压帧失败：${(error as Error).message}`);
      }
    }
    if (queued.length === 0) queuedBytes = 0;
  };

  const sendUpstream = (data: WebSocket.Data, binary: boolean): void => {
    // ws 的 send 不接受 Buffer[]，先归一化成单一缓冲区。
    const payload: string | Buffer | ArrayBuffer = Array.isArray(data)
      ? Buffer.concat(data)
      : data;
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(payload, { binary });
      return;
    }
    const size = rawDataByteLength(payload);
    if (queued.length >= MAX_QUEUED_UPSTREAM_FRAMES || queuedBytes + size > MAX_QUEUED_UPSTREAM_BYTES) {
      diagnose("上游尚未就绪，积压帧超出限制，关闭全部下游连接");
      closeAllDownstreams(1011, UPSTREAM_CLOSE_REASON);
      return;
    }
    queued.push({ data: payload, binary });
    queuedBytes += size;
    void ensureUpstream();
  };

  const handleUpstreamMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    if (isBinary) {
      diagnose("上游发送了二进制帧，这不是 codex-host 的帧格式");
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.close(1003, "codex-host bridge expects text frames");
      }
      return;
    }
    const frame = rawDataToString(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      // Host 的每一帧都是完整 JSON；解析失败时按原帧广播，避免丢数据。
      broadcast(frame);
      return;
    }
    if (!isRecord(parsed)) {
      broadcast(frame);
      return;
    }
    const hasId = "id" in parsed;
    const method = typeof parsed.method === "string" ? parsed.method : null;
    if (hasId && method) {
      // Host 主动发起的请求（审批、提问）：id 由 Host 生成，下游原样带回即可。
      const threadId = extractThreadId(parsed);
      const requestId = String(parsed.id);
      const subscribers = subscribersOf(threadId);
      // 有订阅信息就只扇给该线程的观察者；否则退回广播，避免审批无人可见。
      const targets = subscribers.length > 0 ? subscribers : [...clients.values()];
      if (targets.length === 0) return;
      if (targets.length === 1) {
        deliver(targets[0], frame);
        return;
      }
      // 多个候选客户端：广播给全部，但只把第一个响应转发给 Host。
      const awaiting = new Set(targets.map((client) => client.id));
      hostRequests.set(requestId, awaiting);
      for (const client of targets) deliver(client, frame);
      return;
    }
    if (hasId) {
      const rewrittenId = String(parsed.id);
      const entry = pending.get(rewrittenId);
      if (entry) {
        pending.delete(rewrittenId);
        // thread/start 的请求参数里没有 threadId（线程此刻还不存在），所以这条
        // 线程的订阅只能从响应里补登记。漏了它，新建线程的后续通知就只剩广播
        // 兜底，多台设备同时连时会把无关帧投给所有客户端。
        if (entry.method === "thread/start") {
          const created = (parsed.result as Record<string, unknown> | undefined)
            ?.thread;
          const createdId =
            isRecord(created) && typeof created.id === "string"
              ? created.id
              : null;
          if (createdId) registerThreadSubscription(entry.client, createdId);
        }
        deliver(entry.client, JSON.stringify({ ...parsed, id: entry.originalId }));
        return;
      }
      broadcast(frame);
      return;
    }
    if (method) {
      const subscribers = subscribersOf(extractThreadId(parsed));
      if (subscribers.length > 0) {
        for (const client of subscribers) deliver(client, frame);
        return;
      }
      broadcast(frame);
      return;
    }
    broadcast(frame);
  };

  const dialUpstream = async (): Promise<void> => {
    const socket = new WebSocket(UPSTREAM_URL, {
      createConnection: () => openUpstreamConnection(descriptor.pipePath),
      // 历史页可能含大图片；原生 daemon 不提供 permessage-deflate。
      maxPayload: 0,
      perMessageDeflate: false,
    });
    upstream = socket;
    socket.on("open", () => {
      diagnose(`已连接 codex-host 管道 ${descriptor.pipePath}`);
      flushQueued(socket);
    });
    socket.on("message", handleUpstreamMessage);
    socket.on("error", (error: Error) => {
      diagnose(`codex-host 上游连接异常：${error.message}`);
    });
    socket.on("close", (code) => {
      if (upstream !== socket) return;
      upstream = null;
      queued.length = 0;
      queuedBytes = 0;
      hostRequests.clear();
      resolvedHostRequests.clear();
      diagnose(`codex-host 上游连接已断开（code=${code}）`);
      closeAllDownstreams(1011, UPSTREAM_CLOSE_REASON);
    });
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      socket.once("open", done);
      socket.once("error", done);
      socket.once("close", done);
    });
  };

  const ensureUpstream = async (): Promise<void> => {
    if (closing) return;
    if (upstream && upstream.readyState !== WebSocket.CLOSED && upstream.readyState !== WebSocket.CLOSING) {
      return;
    }
    if (dialing) {
      await dialing;
      return;
    }
    dialing = dialUpstream();
    try {
      await dialing;
    } finally {
      dialing = null;
    }
  };

  const handleDownstreamMessage = (
    client: DownstreamClient,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): void => {
    if (isBinary) {
      diagnose(`下游 ${client.id} 发送了二进制帧，按 codex-host 语义关闭该连接`);
      client.socket.close(1003, "Codex app-server messages must be text");
      return;
    }
    const frame = rawDataToString(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      diagnose(`下游 ${client.id} 发送了无法解析的帧，已跳过`);
      return;
    }
    if (!isRecord(parsed)) {
      sendUpstream(frame, false);
      return;
    }
    const hasId = "id" in parsed;
    if (hasId && typeof parsed.method === "string") {
      const originalId = parsed.id;
      const rewrittenId = `${client.id}:${String(originalId)}`;
      pending.set(rewrittenId, { client, originalId, method: parsed.method });
      trackThreadActivity(client, parsed);
      sendUpstream(JSON.stringify({ ...parsed, id: rewrittenId }), false);
      return;
    }
    // 通知（无 id）与响应（无 method，例如回复 Host 的审批请求）都原样转发；
    // 但 Host 主动发起的请求只接受第一个响应，避免多个客户端重复回复。
    if (hasId) {
      const responseId = String(parsed.id);
      const awaiting = hostRequests.get(responseId);
      if (awaiting) {
        if (resolvedHostRequests.has(responseId)) {
          diagnose(`下游 ${client.id} 重复回复 Host 请求，已忽略`);
          return;
        }
        if (!awaiting.has(client.id)) {
          diagnose(`下游 ${client.id} 不是该 Host 请求的候选响应方，已忽略`);
          return;
        }
        // 第一个响应被接受后即视为已解决，其余客户端的重复响应一律丢弃。
        resolvedHostRequests.add(responseId);
      }
    }
    trackThreadActivity(client, parsed);
    sendUpstream(frame, false);
    return;
  };

  const httpServer: Server = createServer((_request, response) => {
    response.writeHead(426, { Connection: "Upgrade", Upgrade: "websocket" });
    response.end();
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 0 });
  wss.on("error", (error: Error) => {
    diagnose(`下游 WebSocket 服务异常：${error.message}`);
  });
  wss.on("connection", (socket) => {
    nextClientId += 1;
    const client: DownstreamClient = {
      id: `c${nextClientId}`,
      socket,
      threads: new Set<string>(),
    };
    clients.set(client.id, client);
    socket.on("message", (data, isBinary) => handleDownstreamMessage(client, data, isBinary));
    socket.on("close", () => removeClient(client));
    socket.on("error", (error: Error) => {
      diagnose(`下游 ${client.id} 连接异常：${error.message}`);
    });
    void ensureUpstream();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("无法读取 codexhost 小桥监听端口");
  }

  let closePromise: Promise<void> | null = null;
  return {
    port: address.port,
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const client of [...clients.values()]) {
          if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.close(1001, DOWNSTREAM_CLOSE_REASON);
          } else {
            client.socket.terminate();
          }
        }
        const forceDownstream = setTimeout(() => {
          for (const client of clients.values()) client.socket.terminate();
        }, 1_000);
        forceDownstream.unref();
        if (upstream) {
          upstream.close(1000, DOWNSTREAM_CLOSE_REASON);
          const forceUpstream = setTimeout(() => upstream?.terminate(), 1_000);
          forceUpstream.unref();
        }
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      })();
      return closePromise;
    },
  };
}
