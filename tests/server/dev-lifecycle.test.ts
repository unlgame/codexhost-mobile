import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 与 bin/dev.mjs 一致：直接以 node 调用 concurrently 的 JS 入口，不走 shell。
// 每条命令因此都是独立 argv 元素，Windows 的 cmd.exe 引号规则完全不参与。
const require = createRequire(import.meta.url);
const concurrentlyPackageJson = require.resolve("concurrently/package.json");
const concurrentlyEntry = resolve(
  dirname(concurrentlyPackageJson),
  require(concurrentlyPackageJson).bin.concurrently,
);
const isWindows = process.platform === "win32";

// Windows 上 concurrently 的命令解析会吃掉反斜杠（`\t` 甚至会被当成制表符），
// 所以路径统一成正斜杠；含空格时才包双引号。POSIX 仍用单引号 shell 转义。
function shellQuote(value: string): string {
  if (isWindows) {
    const normalized = value.replaceAll("\\", "/");
    return /\s/.test(normalized) ? `"${normalized}"` : normalized;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// 两个平台都把 JS 源码落成临时 .mjs 文件，只把文件路径交给命令行：
// - Windows 上源码塞进 cmd 命令行会被引号规则搅碎（反斜杠、分号都被吃掉）；
// - POSIX 上 `node -e` 会让 process.argv[1] 变成第一个用户参数而不是脚本路径，
//   脚本里读 process.argv[2] 恒为 undefined，子进程会立刻抛错退出。
async function nodeScript(source: string, args: string[] = []): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-mobile-dev-script-"));
  const file = join(directory, "script.mjs");
  await writeFile(file, source, "utf8");
  const argv = args.map(shellQuote).join(" ");
  return `${shellQuote(process.execPath)} ${shellQuote(file)}${argv ? ` ${argv}` : ""}`;
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 4_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("concurrently 没有在预期时间内退出"));
    }, timeoutMs);

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    try {
      return Number.parseInt(await readFile(path, "utf8"), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  throw new Error(`子进程没有写入 PID：${path}`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
// Windows 的进程终止是异步的：taskkill 返回后整棵树可能还在退出中。
// 轮询等待而不是立刻断言，否则父进程 exit 事件后孙进程可能还没死，偶发失败。
async function waitForGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isRunning(pid);
}

// Windows 没有跨进程的信号传播，child.kill("SIGTERM") 只会终结 cmd.exe 本身，
// concurrently 与其子进程会被留下。终止整棵进程树才是这里的等价语义。
function terminateTree(child: ReturnType<typeof spawn>): void {
  if (!isWindows || child.pid === undefined) {
    child.kill("SIGTERM");
    return;
  }
  execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
  });
}

// 每条命令作为独立 argv 元素传给 concurrently，由它自己走 shell 解析；
// 测试因此与 bin/dev.mjs 的启动方式完全一致，也避开了 cmd.exe 的引号规则。
function spawnConcurrent(commands: string[]) {
  return spawn(
    process.execPath,
    [concurrentlyEntry, "--kill-others", "--success", "first", ...commands],
    { stdio: "ignore" },
  );
}

describe("开发双进程生命周期", () => {
  it.each([
    ["正常退出", 0, 0],
    ["异常退出", 7, 1],
  ])("%s时会关闭另一个子进程", async (_name, childExit, parentExit) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-mobile-dev-"));
    const survivorPidPath = join(directory, "survivor.pid");
    const survivor = await nodeScript(
      `import { writeFileSync } from "node:fs";
       writeFileSync(process.argv[2], String(process.pid));
       setInterval(() => {}, 1000);`,
      [survivorPidPath],
    );
    const terminator = await nodeScript(
      `setTimeout(() => process.exit(Number(process.argv[2])), 80);`,
      [String(childExit)],
    );

    let survivorPid: number | undefined;

    try {
      const child = spawnConcurrent([survivor, terminator]);
      survivorPid = await waitForPid(survivorPidPath);
      const result = await waitForExit(child);

      expect(result.code).toBe(parentExit);
      expect(await waitForGone(survivorPid), `survivor 仍存活：${survivorPid}`).toBe(true);
    } finally {
      if (survivorPid && isRunning(survivorPid)) {
        process.kill(survivorPid, "SIGKILL");
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("收到 SIGTERM 时会关闭全部子进程", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-mobile-dev-"));
    const firstPidPath = join(directory, "first.pid");
    const secondPidPath = join(directory, "second.pid");
    const persistentCommand = async (path: string) =>
      await nodeScript(
        `import { writeFileSync } from "node:fs";
         writeFileSync(process.argv[2], String(process.pid));
         setInterval(() => {}, 1000);`,
        [path],
      );

    let childPids: number[] = [];

    try {
      const child = spawnConcurrent([
        await persistentCommand(firstPidPath),
        await persistentCommand(secondPidPath),
      ]);
      childPids = await Promise.all([
        waitForPid(firstPidPath),
        waitForPid(secondPidPath),
      ]);

      terminateTree(child);
      await waitForExit(child);

      const gone = await Promise.all(childPids.map((pid) => waitForGone(pid)));
      expect(gone.every(Boolean), `仍有子进程存活：${JSON.stringify(childPids)}`).toBe(true);
    } finally {
      for (const pid of childPids) {
        if (isRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
