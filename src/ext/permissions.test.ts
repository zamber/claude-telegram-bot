import { describe, test, expect, beforeEach } from "bun:test";
import type { Api } from "grammy";
import {
  DECISION_CODES,
  PERMISSION_CALLBACK_PREFIX,
  _resetPermissionsForTest,
  pendingPermissionCount,
  requestPermission,
  resolveAskTap,
  resolvePendingPlanExit,
  resolvePermission,
  setPermissionApi,
  type PermissionApi,
} from "./permissions";

type Keyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

type SentMessage = {
  chatId: number | string;
  text: string;
  options: { reply_markup?: Keyboard; message_thread_id?: number } | undefined;
};

type EditCall = {
  chatId: number | string;
  messageId: number;
  text: string;
  options: { reply_markup?: Keyboard } | undefined;
};

let sent: SentMessage[] = [];
let edits: EditCall[] = [];
/** When true the next editMessageText throws synchronously, to probe ordering. */
let editThrows = false;

/**
 * Minimal fake Bot API, typed as the exact subset the module uses. Because the
 * object literal is contextually typed, grammY's real argument order is checked
 * here - a swapped (message_id, chat_id) would not compile. Every edit is
 * recorded, so a missing `reply_markup` cannot pass unnoticed.
 */
function fakeApi(): PermissionApi {
  return {
    sendMessage: async (chatId, text, options) => {
      sent.push({
        chatId,
        text,
        options: options as SentMessage["options"],
      });
      return {
        message_id: 100 + sent.length,
        date: 0,
        chat: { id: chatId, type: "private" },
      } as unknown as Awaited<ReturnType<Api["sendMessage"]>>;
    },
    editMessageText: async (chatId, messageId, text, options) => {
      if (editThrows) throw new Error("edit exploded synchronously");
      edits.push({
        chatId,
        messageId,
        text,
        options: options as EditCall["options"],
      });
      return {
        message_id: messageId,
        date: 0,
        chat: { id: chatId, type: "private" },
        text,
      } as unknown as Awaited<ReturnType<Api["editMessageText"]>>;
    },
  };
}

/** Wait one macrotask so requestPermission() reaches its send. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The request id embedded in a button's callback_data. */
function idFromButton(message: SentMessage): string {
  const data = message.options!.reply_markup!.inline_keyboard[0]![0]!
    .callback_data;
  return data.slice(PERMISSION_CALLBACK_PREFIX.length).split(":")[0]!;
}

/** All button labels of a message, flattened. */
function labelsOf(markup: Keyboard | undefined): string[] {
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
}

/** The reply_markup of the most recent edit. */
function lastEditMarkup(): Keyboard | undefined {
  return edits[edits.length - 1]!.options?.reply_markup;
}

/** One AskUserQuestion input with `count` options. */
function askInput(questionText = "Pick one", multiSelect = false) {
  return {
    questions: [
      {
        question: questionText,
        header: "Header",
        multiSelect,
        options: [
          { label: "First choice", description: "the first" },
          { label: "Second choice", description: "the second" },
        ],
      },
    ],
  };
}

beforeEach(() => {
  _resetPermissionsForTest();
  sent = [];
  edits = [];
  editThrows = false;
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
    const labels = labelsOf(sent[0]!.options!.reply_markup);
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

    expect(labelsOf(sent[0]!.options!.reply_markup)).not.toContain(
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

  test("an abort mid-flight denies and clears the keyboard", async () => {
    const controller = new AbortController();
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
      signal: controller.signal,
    });
    await flush();

    controller.abort();
    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toBe("Permission request was cancelled.");
    }
    expect(pendingPermissionCount()).toBe(0);
    expect(lastEditMarkup()).toEqual({ inline_keyboard: [] });
    expect(edits[0]!.text).toContain("Cancelled");
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

describe("settled prompt message", () => {
  test("clears the keyboard and keeps the tool context on allow", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls /tmp" },
      chatId: 42,
    });
    await flush();

    resolvePermission(idFromButton(sent[0]!), "allow");
    await promise;

    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe(42);
    expect(edits[0]!.messageId).toBe(101);
    // Telegram keeps the old markup when an edit omits reply_markup, so the
    // explicit empty keyboard is what makes the buttons disappear.
    expect(lastEditMarkup()).toEqual({ inline_keyboard: [] });
    // The settled text keeps the prompt and appends the outcome.
    expect(edits[0]!.text).toContain("Permission needed");
    expect(edits[0]!.text).toContain("✅ Allowed");
    expect(edits[0]!.text).toContain("<code>Bash</code>");
  });

  test("clears the keyboard on deny too", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
    });
    await flush();

    resolvePermission(idFromButton(sent[0]!), "deny");
    await promise;

    expect(lastEditMarkup()).toEqual({ inline_keyboard: [] });
    expect(edits[0]!.text).toContain("⛔ Denied");
  });

  test("a timeout denies, clears the keyboard and settles", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
      timeoutMs: 10,
    });
    await flush();

    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toBe(
        "Permission request timed out with no answer."
      );
    }
    expect(pendingPermissionCount()).toBe(0);
    expect(lastEditMarkup()).toEqual({ inline_keyboard: [] });
    expect(edits[0]!.text).toContain("Timed out");
  });

  test("a second tap on a settled request returns null", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
    });
    await flush();

    const requestId = idFromButton(sent[0]!);
    expect(resolvePermission(requestId, "allow")).not.toBeNull();
    await promise;
    expect(resolvePermission(requestId, "allow")).toBeNull();
  });

  test("a synchronous throw from the edit cannot strand the promise", async () => {
    editThrows = true;
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
    });
    await flush();

    resolvePermission(idFromButton(sent[0]!), "allow");

    const outcome = await Promise.race([
      promise.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("stranded"), 200)),
    ]);
    expect(outcome).toBe("settled");
    expect(pendingPermissionCount()).toBe(0);
  });
});

describe("resolvePermission", () => {
  test("unknown request id returns null", () => {
    expect(resolvePermission("deadbeef", "allow")).toBeNull();
  });

  test("passes a custom deny message through to the SDK", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
    });
    await flush();

    resolvePermission(
      idFromButton(sent[0]!),
      "deny",
      'The user denied permission for Bash. User said: "no thanks"'
    );
    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("no thanks");
    }
  });

  test("mapping covers the three decision letters", () => {
    expect(DECISION_CODES.a).toBe("allow");
    expect(DECISION_CODES.w).toBe("always");
    expect(DECISION_CODES.d).toBe("deny");
  });
});

describe("AskUserQuestion gate", () => {
  test("renders the question itself, not a bare tool name", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "AskUserQuestion",
      input: askInput("Which database?"),
      chatId: 42,
    });
    await flush();

    expect(sent[0]!.text).toContain("Which database?");
    expect(sent[0]!.text).toContain("First choice");
    const buttons = sent[0]!.options!.reply_markup!.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual([
      "First choice",
      "Second choice",
      "⛔ Cancel",
    ]);
    expect(buttons.map((b) => b.callback_data)).toEqual([
      `perm:${idFromButton(sent[0]!)}:o00`,
      `perm:${idFromButton(sent[0]!)}:o01`,
      `perm:${idFromButton(sent[0]!)}:x`,
    ]);

    resolveAskTap(idFromButton(sent[0]!), "o00");
    await promise;
  });

  test("a tap sends the chosen label back as answers, keyed by question text", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "AskUserQuestion",
      input: askInput("Which database?"),
      chatId: 42,
    });
    await flush();

    const requestId = idFromButton(sent[0]!);
    const resolved = resolveAskTap(requestId, "o01");
    expect(resolved).toEqual({
      toolName: "AskUserQuestion",
      sessionKey: "default",
      status: "settled",
    });

    const result = await promise;
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      // The value must be the full label, not the shortened button text.
      expect(result.updatedInput).toEqual({
        ...askInput("Which database?"),
        answers: { "Which database?": "Second choice" },
      });
    }
    expect(pendingPermissionCount()).toBe(0);
    expect(lastEditMarkup()).toEqual({ inline_keyboard: [] });
    expect(edits[0]!.text).toContain("✅ Answered: Second choice");
  });

  test("an intermediate tap re-renders the keyboard without settling", async () => {
    const input = {
      questions: [
        {
          question: "First?",
          header: "H",
          multiSelect: false,
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
        {
          question: "Second?",
          header: "H",
          multiSelect: false,
          options: [
            { label: "C", description: "c" },
            { label: "D", description: "d" },
          ],
        },
      ],
    };
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "AskUserQuestion",
      input,
      chatId: 42,
    });
    await flush();

    const requestId = idFromButton(sent[0]!);
    expect(resolveAskTap(requestId, "o00")!.status).toBe("updated");
    expect(pendingPermissionCount()).toBe(1);
    // The re-render keeps the question text and drops nothing.
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("Second?");

    expect(resolveAskTap(requestId, "o11")!.status).toBe("settled");
    const result = await promise;
    if (result.behavior === "allow") {
      expect(result.updatedInput).toMatchObject({
        answers: { "First?": "A", "Second?": "D" },
      });
    }
  });

  test("multi-select toggles and settles on Done with comma-joined labels", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Pick some",
            header: "H",
            multiSelect: true,
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
              { label: "C", description: "c" },
            ],
          },
        ],
      },
      chatId: 42,
    });
    await flush();

    const requestId = idFromButton(sent[0]!);
    expect(resolveAskTap(requestId, "o00")!.status).toBe("updated");
    expect(resolveAskTap(requestId, "o02")!.status).toBe("updated");
    expect(resolveAskTap(requestId, "D0")!.status).toBe("settled");

    const result = await promise;
    if (result.behavior === "allow") {
      expect(result.updatedInput).toMatchObject({
        answers: { "Pick some": "A, C" },
      });
    }
  });

  test("Cancel denies without any answers", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "AskUserQuestion",
      input: askInput(),
      chatId: 42,
    });
    await flush();

    const resolved = resolveAskTap(idFromButton(sent[0]!), "x");
    expect(resolved!.status).toBe("cancelled");

    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toBe("The user declined to answer the question.");
    }
  });

  test("an ask tag on a non-ask request is invalid and leaves it pending", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "Bash",
      input: { command: "ls" },
      chatId: 42,
    });
    await flush();

    const requestId = idFromButton(sent[0]!);
    expect(resolveAskTap(requestId, "o00")!.status).toBe("invalid");
    expect(pendingPermissionCount()).toBe(1);

    resolvePermission(requestId, "deny");
    await promise;
  });

  test("an out-of-range option tag is invalid and leaves the request pending", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "AskUserQuestion",
      input: askInput(),
      chatId: 42,
    });
    await flush();

    const requestId = idFromButton(sent[0]!);
    // Only two options exist; "o02" addresses a third.
    expect(resolveAskTap(requestId, "o02")!.status).toBe("invalid");
    expect(pendingPermissionCount()).toBe(1);

    resolveAskTap(requestId, "x");
    await promise;
  });

  test("a malformed input falls back to the generic gate", async () => {
    const promise = requestPermission({
      sessionKey: "default",
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "only one option" }] },
      chatId: 42,
    });
    await flush();

    expect(sent[0]!.text).toContain("Permission needed");
    expect(labelsOf(sent[0]!.options!.reply_markup)).toContain("✅ Allow");

    const requestId = idFromButton(sent[0]!);
    expect(resolveAskTap(requestId, "o00")!.status).toBe("invalid");

    resolvePermission(requestId, "deny");
    expect((await promise).behavior).toBe("deny");
  });

  test("unknown request id returns null", () => {
    expect(resolveAskTap("deadbeef", "o00")).toBeNull();
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
