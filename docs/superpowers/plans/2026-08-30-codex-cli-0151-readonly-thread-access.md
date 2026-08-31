# Codex CLI 0.151.0 与只读分页会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把 MacBook 与 Mac mini 的 managed App Server 升级到 `@openai/codex@0.151.0`，再让 Codex Mobile 正确区分可交互会话和被其他 App Server 占用的只读分页会话。

**Architecture:** Codex 的单写入者锁作为正式边界：只有 `thread/resume` 成功的连接可以执行写操作；精确识别 `already has an active writer` 后，通过 `thread/read(includeTurns=false)` 与 `thread/turns/list` 提供只读历史。其他 resume 错误保留原始错误，不进入只读回退；只读页面禁用所有写入口，并允许用户在释放桌面端占用后重新尝试 resume。

**Tech Stack:** Codex App Server 0.151.0、React、TypeScript、Vitest、WebSocket JSON-RPC、npm/bun、macOS launchd、SSH

---

### Task 1: 双机 Codex CLI 0.151.0 升级

**Files:**
- Preserve: `/Users/loock/Library/Application Support/CodexMobileWeb/gateway.env`
- Preserve: `/Users/loock/Library/LaunchAgents/vip.loock.codex-mobile-web.gateway.plist`
- Preserve remote: Mac mini 上同名配置文件

- [ ] **Step 1: 记录 RED 基线**

Run:

```bash
codex --version
ssh macmini 'codex --version'
npm view @openai/codex dist-tags.latest
```

Expected: 两台机器为 `0.146.0`，registry latest 为 `0.151.0`。

- [ ] **Step 2: 升级 MacBook 并重启网关**

Run:

```bash
bun add --global @openai/codex@0.151.0
launchctl kickstart -k "gui/$(id -u)/vip.loock.codex-mobile-web.gateway"
```

Expected: `codex --version` 返回 `0.151.0`，18766 与 18765 恢复监听。

- [ ] **Step 3: 升级 Mac mini 并重启网关**

Run:

```bash
ssh macmini '/usr/local/bin/npm install --global --prefix /opt/homebrew @openai/codex@0.151.0 --no-audit --no-fund && launchctl kickstart -k "gui/$(id -u)/vip.loock.codex-mobile-web.gateway"'
```

Expected: 远端 `codex --version` 返回 `0.151.0`，18766 与 18765 恢复监听。

- [ ] **Step 4: 运行真实协议验收**

Run: 通过两端现有 Token 连接 `/ws`，执行 `initialize`、`thread/read(includeTurns=false)` 与 `thread/turns/list`；对本机已被 Codex Desktop 占用的分页线程执行一次 `thread/resume(excludeTurns=true, initialTurnsPage=...)`。

Expected: 两端只读分页接口成功；占用线程的 resume 返回 active writer 冲突而不是分页读取错误；Token 不输出。

### Task 2: 精确区分 interactive 与 readOnly

**Files:**
- Modify: `src/app-server/thread-session.ts`
- Modify: `tests/ui/thread-session.test.ts`

- [ ] **Step 1: 编写失败测试**

新增断言：

```ts
expect(result.accessMode).toBe("readOnly");
expect(result.resumeError).toContain("active writer");
```

并增加普通网络错误测试，断言 `thread/read` 与 `thread/turns/list` 均未调用且原错误被抛出。

- [ ] **Step 2: 验证 RED**

Run: `npm test -- --run tests/ui/thread-session.test.ts`

Expected: 缺少 `accessMode`，且当前宽泛 catch 会错误进入回退。

- [ ] **Step 3: 最小实现**

在 `ResumedThreadSession` 增加：

```ts
accessMode: "interactive" | "readOnly";
resumeError?: string;
```

仅当错误消息包含 `already has an active writer` 时进入只读分页路径；正常 resume 返回 `interactive`，其他错误重新抛出。

- [ ] **Step 4: 验证 GREEN**

Run: `npm test -- --run tests/ui/thread-session.test.ts`

Expected: 所有 thread-session 测试通过，源码不含 `includeTurns: true`。

### Task 3: 只读模式禁止写操作并允许重试

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/features/conversation/ConversationPage.tsx`
- Modify: `src/i18n.tsx`
- Modify: `tests/ui/conversation-page-pagination.test.tsx`
- Modify: 现有 App 会话恢复测试文件

- [ ] **Step 1: 编写失败 UI 测试**

构造 `accessMode="readOnly"`，断言：

```ts
expect(screen.getByText("该会话正在其他 Codex 客户端运行，当前为只读模式")).not.toBeNull();
expect(screen.getByPlaceholderText("向 Codex 提问")).toBeDisabled();
expect(screen.getByRole("button", { name: "重新连接" })).not.toBeNull();
```

- [ ] **Step 2: 验证 RED**

Run: `npm test -- --run tests/ui/conversation-page-pagination.test.tsx`

Expected: 只读提示和重连入口不存在，输入框仍可写。

- [ ] **Step 3: 实现访问状态**

`App.tsx` 保存活动会话的 `accessMode` 与 `resumeError`；`ConversationPage` 在只读模式禁用文本、附件、语音、审批与发送入口。重连按钮重新调用同一 `loadThreadDetail`，成功后切换为 `interactive`。

- [ ] **Step 4: 阻断函数级写入**

在提交消息、引导消息及其他线程写操作入口增加 `accessMode !== "interactive"` 的提前返回，避免仅靠 disabled DOM。

- [ ] **Step 5: 验证 GREEN**

Run: `npm test -- --run tests/ui/conversation-page-pagination.test.tsx`

Expected: 只读 UI、禁用写入和重新连接测试通过。

### Task 4: 只读会话前台刷新

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/app-server/thread-session.ts`
- Test: `tests/ui/thread-session.test.ts`
- Test: 现有 App 前后台恢复测试文件

- [ ] **Step 1: 编写失败测试**

断言只读会话在页面可见时刷新最新 10 轮，后台暂停；回到前台立即读取一次，并使用现有 turn id 去重。

- [ ] **Step 2: 验证 RED**

Run: 对应 Vitest 文件的定向测试。

Expected: 当前只读状态没有刷新调度。

- [ ] **Step 3: 最小实现**

只读且页面可见时每 3 秒调用 `loadRecentThreadTurns`；`visibilitychange` 回到前台时立即刷新。停止只读或切换会话时清理定时器。

- [ ] **Step 4: 验证 GREEN**

Run: 对应定向测试。

Expected: 定时器、前台恢复和清理断言通过。

### Task 5: 完整验证与交付

**Files:**
- Verify: 全部源码、测试与两台实时服务

- [ ] **Step 1: 全量验证**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 测试零失败、类型检查和生产构建退出码为 0。

- [ ] **Step 2: 真实冲突验收**

让 Codex Desktop 保持目标分页会话写入锁，使用 Codex Mobile 打开它。

Expected: 历史可见、提示只读、不能发送、不出现 `paginated threads do not support...`；释放桌面端占用后点击重新连接恢复交互。

- [ ] **Step 3: 检查工作区范围**

Run: `git status --short` 与 `git diff --check`。

Expected: 仅包含本计划和本次线程访问相关修改，不触碰用户其他文件。
