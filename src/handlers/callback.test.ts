import { describe, test, expect, beforeEach } from "bun:test";
import type { Api, Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { _resetSessionsForTest } from "../ext/session-manager";
import {
  _resetPermissionsForTest,
  requestPermission,
  setPermissionApi,
  type PermissionApi,
} from "../ext/permissions";
import { handleCallback } from "./callback";

const ALLOWED_USER = ALLOWED_USERS[0]!;

type Keyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

let sent: { text: string; requestId: string }[] = [];
let edits: { chatId: number | string; messageId: number; text: string }[] = [];

/**
 * The subset of the Bot API the permission module uses. The request id is read
 * back out of the keyboard this fake posts, so the tests address the gate the
 * same way Telegram does.
 */
function fakePermissionApi(): PermissionApi {
  return {
    sendMessage: async (chatId, text, options) => {
      const keyboard = (options as { reply_markup?: Keyboard } | undefined)
        ?.reply_markup;
      const requestId = (
        keyboard?.inline_keyboard[0]?.[0]?.callback_data ?? ""
      ).split(":")[1]!;
      sent.push({ text, requestId });
      return {
        message_id: 100 + sent.length,
        date: 0,
        chat: { id: chatId, type: "private" },
      } as unknown as Awaited<ReturnType<Api["sendMessage"]>>;
    },
    editMessageText: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
      return {
        message_id: messageId,
        date: 0,
        chat: { id: chatId, type: "private" },
        text,
      } as unknown as Awaited<ReturnType<Api["editMessageText"]>>;
    },
  };
}

type FakeCtx = { ctx: Context; answers: unknown[] };

function fakeCtx(
  data: string,
  options: { userId?: number; chatId?: number } = {}
): FakeCtx {
  const answers: unknown[] = [];
  const ctx = {
    from: { id: options.userId ?? ALLOWED_USER, username: "tester" },
    chat: { id: options.chatId ?? 42 },
    callbackQuery: { data },
    answerCallbackQuery: async (arg?: unknown) => {
      answers.push(arg);
    },
  };
  return { ctx: ctx as unknown as Context, answers };
}

/** The toast text of the single answerCallbackQuery call. */
function toastText(answers: unknown[]): string | undefined {
  expect(answers).toHaveLength(1);
  return (answers[0] as { text?: string } | undefined)?.text;
}

/** Post a real gate and return its request id plus the SDK promise. */
async function pendingGate(
  toolName = "Bash",
  input: Record<string, unknown> = { command: "ls" }
): Promise<{ requestId: string; settled: Promise<unknown> }> {
  const settled = requestPermission({
    sessionKey: "default",
    toolName,
    input,
    chatId: 42,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { requestId: sent[sent.length - 1]!.requestId, settled };
}

/** A minimal well-formed AskUserQuestion input. */
const ASK_INPUT = {
  questions: [
    {
      question: "Pick one",
      header: "H",
      multiSelect: false,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    },
  ],
};

beforeEach(() => {
  _resetSessionsForTest();
  _resetPermissionsForTest();
  sent = [];
  edits = [];
  setPermissionApi(fakePermissionApi());
});

describe("handleCallback - permission taps", () => {
  test("a live allow tap settles the gate and reports the tool", async () => {
    const { requestId, settled } = await pendingGate();

    const { ctx, answers } = fakeCtx(`perm:${requestId}:a`);
    await handleCallback(ctx);

    expect(toastText(answers)).toBe("Allowed: Bash");
    expect(await settled).toMatchObject({ behavior: "allow" });
  });

  test("a live deny tap reports the tool", async () => {
    const { requestId, settled } = await pendingGate();

    const { ctx, answers } = fakeCtx(`perm:${requestId}:d`);
    await handleCallback(ctx);

    expect(toastText(answers)).toBe("Denied: Bash");
    expect(await settled).toMatchObject({ behavior: "deny" });
  });

  test("an ask option tap settles with 'Answer sent'", async () => {
    const { requestId, settled } = await pendingGate(
      "AskUserQuestion",
      ASK_INPUT
    );

    const { ctx, answers } = fakeCtx(`perm:${requestId}:o01`);
    await handleCallback(ctx);

    expect(toastText(answers)).toBe("✅ Answer sent");
    const result = (await settled) as {
      behavior: string;
      updatedInput?: { answers?: Record<string, string> };
    };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput?.answers).toEqual({ "Pick one": "B" });
  });

  test("an ask cancel tap reports 'Cancelled' and denies", async () => {
    const { requestId, settled } = await pendingGate(
      "AskUserQuestion",
      ASK_INPUT
    );

    const { ctx, answers } = fakeCtx(`perm:${requestId}:x`);
    await handleCallback(ctx);

    expect(toastText(answers)).toBe("Cancelled");
    expect(await settled).toMatchObject({ behavior: "deny" });
  });

  test("an ask tag on a non-ask gate reports 'Invalid choice'", async () => {
    const { requestId, settled } = await pendingGate();

    const { ctx, answers } = fakeCtx(`perm:${requestId}:o00`);
    await handleCallback(ctx);

    expect(toastText(answers)).toBe("Invalid choice");
    expect(sent).toHaveLength(1);

    // Still pending, so a later Allow tap can settle it.
    await handleCallback(fakeCtx(`perm:${requestId}:a`).ctx);
    expect(await settled).toMatchObject({ behavior: "allow" });
  });

  test("an unknown request id alerts that the request expired", async () => {
    const { ctx, answers } = fakeCtx("perm:deadbeef:a");
    await handleCallback(ctx);

    expect(answers[0]).toMatchObject({
      text: "This request expired.",
      show_alert: true,
    });
  });

  test("a second tap on the same gate alerts too", async () => {
    const { requestId, settled } = await pendingGate();

    await handleCallback(fakeCtx(`perm:${requestId}:a`).ctx);
    await settled;

    const second = fakeCtx(`perm:${requestId}:a`);
    await handleCallback(second.ctx);
    expect(second.answers[0]).toMatchObject({
      text: "This request expired.",
      show_alert: true,
    });
  });

  test("a missing or unknown code is rejected", async () => {
    const missing = fakeCtx("perm:abc12345");
    await handleCallback(missing.ctx);
    expect(toastText(missing.answers)).toBe("Invalid permission callback");

    const unknown = fakeCtx("perm:abc12345:zz");
    await handleCallback(unknown.ctx);
    expect(toastText(unknown.answers)).toBe("Invalid permission callback");

    const outOfRange = fakeCtx("perm:abc12345:o44");
    await handleCallback(outOfRange.ctx);
    expect(toastText(outOfRange.answers)).toBe("Invalid permission callback");
  });

  test("an unauthorized user is refused before any lookup", async () => {
    const { requestId, settled } = await pendingGate();

    const { ctx, answers } = fakeCtx(`perm:${requestId}:a`, {
      userId: ALLOWED_USER + 1,
    });
    await handleCallback(ctx);

    expect(toastText(answers)).toBe("Unauthorized");

    // The gate is untouched, so the allowlisted user can still settle it.
    await handleCallback(fakeCtx(`perm:${requestId}:a`).ctx);
    expect(await settled).toMatchObject({ behavior: "allow" });
  });
});

describe("handleCallback - unrelated data", () => {
  test("unknown callback data is acknowledged without a toast", async () => {
    const { ctx, answers } = fakeCtx("something-else");
    await handleCallback(ctx);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toBeUndefined();
  });
});
