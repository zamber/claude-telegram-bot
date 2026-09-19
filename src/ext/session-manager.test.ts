import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Context } from "grammy";
import {
  keyForCtx,
  getSession,
  _resetSessionsForTest,
} from "./session-manager";
import {
  getMappedSessionId,
  setMappedSessionId,
  _resetSessionMapForTest,
} from "./session-map";
import { ClaudeSession } from "../session";

// Minimal fake ctx: keyForCtx/getSession only ever read ctx.msg and ctx.chat,
// both plain property reads on the real Context class too, so a plain object
// cast is sufficient and keeps these tests free of any real grammY/Telegram setup.
function fakeCtx(chatId: number, threadId?: number): Context {
  return {
    chat: { id: chatId },
    msg: threadId === undefined ? {} : { message_thread_id: threadId },
  } as unknown as Context;
}

beforeEach(() => {
  _resetSessionsForTest();
  _resetSessionMapForTest();
  delete process.env.SESSION_FILE;
  delete process.env.SESSION_MAP_FILE;
});

describe("keyForCtx", () => {
  test("no thread id maps to the literal 'default' key", () => {
    expect(keyForCtx(fakeCtx(123))).toBe("default");
  });

  test("with a thread id, keys by chatId:threadId", () => {
    expect(keyForCtx(fakeCtx(123, 45))).toBe("123:45");
  });

  test("different threads in the same chat get different keys", () => {
    expect(keyForCtx(fakeCtx(123, 1))).not.toBe(keyForCtx(fakeCtx(123, 2)));
  });

  test("same chat+thread always yields the same key", () => {
    expect(keyForCtx(fakeCtx(123, 45))).toBe(keyForCtx(fakeCtx(123, 45)));
  });
});

describe("getSession", () => {
  test("returns the same instance for the same key", () => {
    const a = getSession(fakeCtx(123, 45));
    const b = getSession(fakeCtx(123, 45));
    expect(a).toBe(b);
  });

  test("returns different instances for different threads", () => {
    const a = getSession(fakeCtx(123, 1));
    const b = getSession(fakeCtx(123, 2));
    expect(a).not.toBe(b);
  });

  test("no-thread messages across different chats share the single 'default' instance", () => {
    // Matches the pre-existing single-singleton behavior for non-forum chats.
    const a = getSession(fakeCtx(111));
    const b = getSession(fakeCtx(222));
    expect(a).toBe(b);
  });
});

describe("restore after restart", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-restore-test-"));
    process.env.SESSION_FILE = join(dir, "history.json");
    process.env.SESSION_MAP_FILE = join(dir, "map.json");
    _resetSessionMapForTest();
    _resetSessionsForTest();
  });

  afterEach(() => {
    delete process.env.SESSION_FILE;
    delete process.env.SESSION_MAP_FILE;
    _resetSessionMapForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a fresh instance after restart restores the thread's persisted session", async () => {
    // A session existed for this thread before the restart.
    const original = new ClaudeSession("123:45");
    original.sessionId = "sess-original";
    original.conversationTitle = "Original thread session";
    await original.saveSession();

    // Simulate the restart: the runtime instance Map is gone.
    _resetSessionsForTest();

    // First access creates a brand-new inactive instance...
    const restored = getSession(fakeCtx(123, 45));
    expect(restored).not.toBe(original);
    expect(restored.isActive).toBe(false);

    // ...which restores the persisted session on first use.
    expect(restored.restorePersistedSession()).toBe(true);
    expect(restored.sessionId).toBe("sess-original");
    expect(restored.conversationTitle).toBe("Original thread session");
  });

  test("/new (kill) clears the mapping so a restart does not resurrect it", async () => {
    const original = new ClaudeSession("123:45");
    original.sessionId = "sess-original";
    await original.saveSession();

    // User explicitly starts fresh.
    await original.kill();
    expect(original.sessionId).toBeNull();

    _resetSessionsForTest();
    const restored = getSession(fakeCtx(123, 45));
    expect(restored.restorePersistedSession()).toBe(false);
    expect(restored.sessionId).toBeNull();
  });

  test("a stale mapping (session dropped from history) is cleared, not resurrected", () => {
    // Write a binding that no longer has a matching history entry.
    setMappedSessionId("123:45", "sess-gone");
    _resetSessionMapForTest();

    const restored = getSession(fakeCtx(123, 45));
    expect(restored.restorePersistedSession()).toBe(false);
    expect(restored.sessionId).toBeNull();
    // Mapping cleared so future restarts don't keep trying.
    expect(getMappedSessionId("123:45")).toBeNull();
  });

  test("different threads keep independent persisted sessions", async () => {
    const a = new ClaudeSession("123:1");
    a.sessionId = "sess-a";
    await a.saveSession();

    const b = new ClaudeSession("123:2");
    b.sessionId = "sess-b";
    await b.saveSession();

    _resetSessionsForTest();
    _resetSessionMapForTest();

    const restoredA = getSession(fakeCtx(123, 1));
    const restoredB = getSession(fakeCtx(123, 2));
    expect(restoredA.restorePersistedSession()).toBe(true);
    expect(restoredB.restorePersistedSession()).toBe(true);
    expect(restoredA.sessionId).toBe("sess-a");
    expect(restoredB.sessionId).toBe("sess-b");
  });
});
