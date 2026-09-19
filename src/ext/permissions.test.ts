import { describe, test, expect, beforeEach } from "bun:test";
import type { Api } from "grammy";
import {
  DECISION_CODES,
  PERMISSION_CALLBACK_PREFIX,
  _resetPermissionsForTest,
  pendingPermissionCount,
  requestPermission,
  resolvePendingPlanExit,
  resolvePermission,
  setPermissionApi,
} from "./permissions";

type SentMessage = {
  chatId: number;
  text: string;
  options?: Record<string, unknown>;
};

let sent: SentMessage[] = [];

/**
 * Minimal fake Bot API. Only sendMessage/editMessageText are used by the
 * module; the cast avoids pulling in grammY's full client surface.
 */
function fakeApi(): Api {
  return {
    sendMessage: async (
      chatId: number,
      text: string,
      options?: Record<string, unknown>
    ) => {
      sent.push({ chatId, text, options });
      return {
        message_id: 100 + sent.length,
        date: 0,
        chat: { id: chatId, type: "private" },
      };
    },
    editMessageText: async () => ({}),
  } as unknown as Api;
}

/** Wait one macrotask so requestPermission() reaches its send. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The request id embedded in a button's callback_data. */
function idFromButton(sent: SentMessage): string {
  const markup = sent.options!.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  const data = markup.inline_keyboard[0]![0]!.callback_data;
  return data.slice(PERMISSION_CALLBACK_PREFIX.length).split(":")[0]!;
}

beforeEach(() => {
  _resetPermissionsForTest();
  sent = [];
  setPermissionApi(fakeApi());
});

describe("requestPermission", () => {
  test("posts an inline keyboard and allows on tap", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls /tmp" },
      chatId: 42,
    });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(42);
    const markup = sent[0]!.options!.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const labels = markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain("✅ Allow");
    expect(labels).toContain("⛔ Deny");

    const requestId = idFromButton(sent[0]!);
    const resolved = resolvePermission(requestId, "allow");
    expect(resolved).toEqual({ toolName: "Bash", sessionKey: "default" });

    const result = await promise;
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual({ command: "ls /tmp" });
    }
    expect(pendingPermissionCount()).toBe(0);
  });

  test("denies on tap and reports the tool", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Write",
      input: { file_path: "/etc/passwd" },
      chatId: 42,
    });
    await flush();

    resolvePermission(idFromButton(sent[0]!), "deny");
    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("Write");
    }
  });

  test("never offers Always when the SDK proposed no suggestions", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "rm -rf /tmp/x" },
      chatId: 42,
    });
    await flush();

    const markup = sent[0]!.options!.reply_markup as {
      inline_keyboard: { text: string }[][];
    };
    expect(markup.inline_keyboard.flat().map((b) => b.text)).not.toContain(
      "♾️ Always"
    );

    resolvePermission(idFromButton(sent[0]!), "deny");
    await promise;
  });

  test("Always replays the SDK suggestions as session rules", async () => {
    const suggestion = {
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
      behavior: "allow" as const,
      destination: "session" as const,
    };
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      suggestions: [suggestion],
      chatId: 42,
    });
    await flush();

    resolvePermission(idFromButton(sent[0]!), "always");
    const result = await promise;
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedPermissions).toEqual([suggestion]);
    }
  });

  test("ExitPlanMode approval switches the CLI mode to default", async () => {
    const promise = requestPermission({
      sessionKey: "1:2",
      toolName: "ExitPlanMode",
      input: { plan: "do the thing" },
      chatId: 42,
    });
    await flush();

    expect(sent[0]!.text).toContain("Plan ready");

    resolvePermission(idFromButton(sent[0]!), "allow");
    const result = await promise;
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedPermissions).toEqual([
        { type: "setMode", mode: "default", destination: "session" },
      ]);
    }
  });

  test("thread id is carried into the prompt message", async () => {
    const promise = requestPermission({
      sessionKey: "1:7",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
      threadId: 7,
    });
    await flush();

    expect(sent[0]!.options!.message_thread_id).toBe(7);
    resolvePermission(idFromButton(sent[0]!), "deny");
    await promise;
  });

  test("an already-aborted signal denies without any prompt", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
      signal: controller.signal,
    });

    expect(result.behavior).toBe("deny");
    expect(pendingPermissionCount()).toBe(0);
    // No keyboard may be posted: an abort that already happened would never
    // settle the request, so it must be rejected up front.
    expect(sent).toHaveLength(0);
  });

  test("resolves to deny when no bot API is registered", async () => {
    _resetPermissionsForTest();
    const result = await requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
    });
    expect(result.behavior).toBe("deny");
    expect(pendingPermissionCount()).toBe(0);
  });
});

describe("resolvePermission", () => {
  test("unknown request id returns null", () => {
    expect(resolvePermission("deadbeef", "allow")).toBeNull();
  });

  test("mapping covers the three decision letters", () => {
    expect(DECISION_CODES.a).toBe("allow");
    expect(DECISION_CODES.w).toBe("always");
    expect(DECISION_CODES.d).toBe("deny");
  });
});

describe("resolvePendingPlanExit", () => {
  test("approves the matching session's pending ExitPlanMode only", async () => {
    const other = requestPermission({
      sessionKey: "other:1",
      toolName: "ExitPlanMode",
      input: {},
      chatId: 7,
    });
    const target = requestPermission({
      sessionKey: "1:2",
      toolName: "ExitPlanMode",
      input: {},
      chatId: 42,
    });
    await flush();

    expect(pendingPermissionCount()).toBe(2);
    expect(resolvePendingPlanExit("1:2")).toBe(true);
    expect(resolvePendingPlanExit("1:2")).toBe(false);

    const targetResult = await target;
    expect(targetResult.behavior).toBe("allow");

    // The other session stays pending until it is resolved on its own.
    expect(pendingPermissionCount()).toBe(1);
    resolvePermission(idFromButton(sent[0]!), "deny");
    expect((await other).behavior).toBe("deny");
  });

  test("returns false when nothing is pending", () => {
    expect(resolvePendingPlanExit("none")).toBe(false);
  });
});
