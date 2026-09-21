import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRuntimeAccess } from "../../server/runtime-access.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI 运行信息", () => {
  it("以仅当前用户可读写的权限保存实际端口和口令", async () => {
    const directory = mkdtempSync(`${tmpdir()}/codex-mobile-runtime-`);
    directories.push(directory);
    const file = resolve(directory, "nested", "runtime.json");

    await writeRuntimeAccess(file, {
      port: 19000,
      token: "secret",
    });

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      port: 19000,
      token: "secret",
    });
    // Windows 不实现 POSIX 权限位，Node 的 fs.chmod 只能翻动只读属性，
    // 位模式断言在 win32 上永远拿不到 0o600。真正的访问控制由 NTFS ACL 决定，
    // 因此按平台断言各自真实成立的安全属性，而不是假装同一种机制。
    if (process.platform === "win32") {
      const acl = execFileSync("icacls", [file], { encoding: "utf8" });
      expect(acl).not.toMatch(
        /Everyone|BUILTIN\\Users|Authenticated Users|DOMAIN\\Users/i,
      );
      const username = process.env.USERNAME;
      if (username) {
        expect(acl.toLowerCase()).toContain(username.toLowerCase());
      }
    } else {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
