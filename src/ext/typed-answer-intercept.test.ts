import { describe, test, expect, beforeEach } from "bun:test";
import type { Api, Context, NextFunction } from "grammy";
import { ALLOWED_USERS } from "../config";
import {
  _resetPermissionsForTest,
  pendingPermissionCount,
  requestPermission,
  setPermissionApi,
  type PermissionApi,
  type PendingTextResult,
} from "./permissions";
import { createTypedAnswerMiddleware } from "./typed-answer-intercept";

const ALLOWED_USER = ALLOWED_USERS[0]!;

let sent: { text: string }[] = [];

function fakePermissionApi(): PermissionApi {
  return {
    sendMessage: async (chatId, text) => {
      sent.push({ text });
      return {
        message_id: 100 + sent.length,
        date: 0,
        chat: { id: chatId, type: "private" },
      } as unknown as Awaited<ReturnType<Api["sendMessage"]>>;
    },
    editMessageText: async (chatId, messageId, text) =>
      ({
        message_id: messageId,
        date: 0,
        chat: { id: chatId, type: "private" },
        text,
      }) as unknown as Awaited<ReturnType<Api["editMessageText"]>>,
  };
}

type FakeCtx = { ctx: Context; replies: string[] };

function fakeCtx(
  options: {
    text?: string;
    userId?: number;
    chatId?: number;
    threadId?: number;
  } = {}
): FakeCtx {
  const replies: string[] = [];

  const ctx: Record<string, unknown> = {
    from: { id: options.userId ?? ALLOWED_USER, username: "tester" },
    chat: { id: options.chatId ?? 42 },
    reply: async (text: string) => {
      replies.push(text);
    },
  };

  if (options.text !== undefined) {
    ctx.message = {
      text: options.text,
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
    };
    // grammY's ctx.msg folds in message/callbackQuery.message, which is what
    // keyForCtx reads. The fake mirrors that.
    ctx.msg = ctx.message;
  }

  return { ctx: ctx as unknown as Context, replies };
}

/**
 * Run the middleware with a stub next, and report whether the chain continued.
 * The whole point of this middleware is that a settled gate does NOT continue.
 */
async function run(
  middleware: (ctx: Context, next: NextFunction) => Promise<void>,
  ctx: Context
): Promise<boolean> {
  let calledNext = false;
  await middleware(ctx, async () => {
    calledNext = true;
  });
  return calledNext;
}

/**
 * Post a real gate for the default session and wait for its prompt.
 *
 * The gate promise is handed back inside an object on purpose. An async
 * function adopts whatever promise it returns, so `return settled` would make
 * this helper resolve only once the gate itself settles - i.e. it would deadlock
 * every test that needs the gate to still be pending.
 */
async function pendingGate(
  toolName = "Bash",
  input: Record<string, unknown> = { command: "ls" }
): Promise<{ gate: Promise<unknown> }> {
  const gate = requestPermission({
    sessionKey: "default",
    toolName,
    input,
    chatId: 42,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { gate };
}

beforeEach(() => {
  _resetPermissionsForTest();
  sent = [];
  setPermissionApi(fakePermissionApi());
});

describe("typed answer middleware - pass-through", () => {
  test("an update with no text is passed through", async () => {
    const { ctx, replies } = fakeCtx();
    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(true);
    expect(replies).toHaveLength(0);
  });

  test("a slash command is left to its own handler", async () => {
    const { gate } = await pendingGate();
    const { ctx, replies } = fakeCtx({ text: "/status" });

    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(true);
    expect(replies).toHaveLength(0);
    expect(pendingPermissionCount()).toBe(1);

    _resetPermissionsForTest();
    void gate;
  });

  test("a bang-prefixed interrupt is left alone", async () => {
    const { gate } = await pendingGate();
    const { ctx, replies } = fakeCtx({ text: "!stop" });

    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(true);
    expect(replies).toHaveLength(0);
    expect(pendingPermissionCount()).toBe(1);

    _resetPermissionsForTest();
    void gate;
  });

  test("an unauthorized user cannot settle a gate", async () => {
    const { gate } = await pendingGate();
    const { ctx, replies } = fakeCtx({ text: "yes", userId: 999 });

    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(true);
    expect(replies).toHaveLength(0);
    expect(pendingPermissionCount()).toBe(1);

    _resetPermissionsForTest();
    void gate;
  });

  test("a message with no pending gate is passed through", async () => {
    const { ctx, replies } = fakeCtx({ text: "hello" });
    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(true);
    expect(replies).toHaveLength(0);
  });

  test("a resolve failure never eats the message", async () => {
    const { ctx, replies } = fakeCtx({ text: "hello" });
    const middleware = createTypedAnswerMiddleware({
      resolve: () => {
        throw new Error("boom");
      },
    });

    const calledNext = await run(middleware, ctx);

    expect(calledNext).toBe(true);
    expect(replies).toHaveLength(0);
  });
});

describe("typed answer middleware - settling", () => {
  test("yes allows the gate, replies, and does not continue the chain", async () => {
    const { gate } = await pendingGate();
    const { ctx, replies } = fakeCtx({ text: "yes" });

    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(false);
    expect(replies).toEqual(["✅ Approved. Claude can continue."]);
    expect((await gate as { behavior: string }).behavior).toBe("allow");
    expect(pendingPermissionCount()).toBe(0);
  });

  test("a sentence denies the gate and forwards the text as the reason", async () => {
    const { gate } = await pendingGate();
    const { ctx, replies } = fakeCtx({ text: "no, use /srv instead" });

    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(false);
    expect(replies).toEqual([
      "⛔ Denied. Your message went to Claude as the reason.",
    ]);
    const result = (await gate) as { behavior: string; message?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe("no, use /srv instead");
  });

  test("free text answers a question card", async () => {
    const { gate } = await pendingGate("AskUserQuestion", {
      questions: [
        {
          question: "Which colour?",
          header: "Colour",
          multiSelect: false,
          options: [
            { label: "Red", description: "r" },
            { label: "Blue", description: "b" },
          ],
        },
      ],
    });
    const { ctx, replies } = fakeCtx({ text: "teal" });

    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(false);
    expect(replies).toEqual(["✅ Answer sent."]);
    const result = (await gate) as {
      behavior: string;
      updatedInput?: { answers?: Record<string, string> };
    };
    expect(result.updatedInput?.answers).toEqual({ "Which colour?": "teal" });
  });

  test("a partial answer reports which question it filled", async () => {
    const { gate } = await pendingGate("AskUserQuestion", {
      questions: [
        {
          question: "First?",
          header: "One",
          multiSelect: false,
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
        {
          question: "Second?",
          header: "Two",
          multiSelect: false,
          options: [
            { label: "C", description: "c" },
            { label: "D", description: "d" },
          ],
        },
      ],
    });
    const { ctx, replies } = fakeCtx({ text: "an answer for the first one" });

    const calledNext = await run(createTypedAnswerMiddleware(), ctx);

    expect(calledNext).toBe(false);
    expect(replies).toEqual(["📝 Answer recorded for question 1 of 2."]);
    expect(pendingPermissionCount()).toBe(1);

    _resetPermissionsForTest();
    void gate;
  });

  test("an expired result continues the chain instead of swallowing the message", async () => {
    const { ctx, replies } = fakeCtx({ text: "hello" });
    const middleware = createTypedAnswerMiddleware({
      resolve: (): PendingTextResult => ({ status: "expired", toolName: "Bash" }),
    });

    const calledNext = await run(middleware, ctx);

    expect(calledNext).toBe(true);
    expect(replies).toHaveLength(0);
  });

  test("a failure to reply does not throw into the bot", async () => {
    const { gate } = await pendingGate();
    const ctx = {
      from: { id: ALLOWED_USER, username: "tester" },
      chat: { id: 42 },
      message: { text: "yes" },
      msg: { text: "yes" },
      reply: async () => {
        throw new Error("telegram is down");
      },
    } as unknown as Context;

    await createTypedAnswerMiddleware()(ctx, async () => {});
    expect((await gate as { behavior: string }).behavior).toBe("allow");
  });
});
