import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import {
  parseRunCaption,
  hasAttachment,
  substituteFileArg,
  createFileRunMiddleware,
} from "./file-run-intercept";
import type { ScriptDef } from "./scripts";

const FIXTURES = resolve(import.meta.dir, "__fixtures__");
// This suite runs against the bot's real config.ts (same as every other test
// file here, since config.ts has module-level env validation side effects),
// so use its actual configured allowlist rather than a hand-picked id.
const AUTHORIZED_ID = ALLOWED_USERS[0]!;
const UNAUTHORIZED_ID = -1; // never a valid Telegram user id

describe("parseRunCaption", () => {
  test("no caption -> null", () => {
    expect(parseRunCaption(undefined)).toBeNull();
  });

  test("caption not starting with /run -> null", () => {
    expect(parseRunCaption("just a normal caption")).toBeNull();
  });

  test("/run with no args -> null (needs at least a script name)", () => {
    expect(parseRunCaption("/run")).toBeNull();
  });

  test("/run <script> -> [script]", () => {
    expect(parseRunCaption("/run transcribe")).toEqual(["transcribe"]);
  });

  test("/run <script> <args...> tokenizes the rest", () => {
    expect(parseRunCaption("/run transcribe {file} pl")).toEqual([
      "transcribe",
      "{file}",
      "pl",
    ]);
  });

  test("/run@botname works like /run", () => {
    expect(parseRunCaption("/run@mybot transcribe {file}")).toEqual([
      "transcribe",
      "{file}",
    ]);
  });
});

describe("hasAttachment", () => {
  test("true for a document message", () => {
    const ctx = { message: { document: {} } } as unknown as Context;
    expect(hasAttachment(ctx)).toBe(true);
  });

  test("true for a photo message", () => {
    const ctx = { message: { photo: [{}] } } as unknown as Context;
    expect(hasAttachment(ctx)).toBe(true);
  });

  test("false for a plain text message", () => {
    const ctx = { message: { text: "hi" } } as unknown as Context;
    expect(hasAttachment(ctx)).toBe(false);
  });
});

describe("substituteFileArg", () => {
  test("replaces an explicit {file} placeholder", () => {
    expect(substituteFileArg(["a", "{file}", "b"], "/tmp/x.mp3")).toEqual([
      "a",
      "/tmp/x.mp3",
      "b",
    ]);
  });

  test("appends the path when there is no placeholder", () => {
    expect(substituteFileArg(["a", "b"], "/tmp/x.mp3")).toEqual(["a", "b", "/tmp/x.mp3"]);
  });

  test("appends the path when there are no args at all", () => {
    expect(substituteFileArg([], "/tmp/x.mp3")).toEqual(["/tmp/x.mp3"]);
  });
});

// Minimal fake ctx/next harness for the middleware itself.
function fakeCtx(opts: { caption?: string; hasDoc?: boolean; userId?: number }) {
  const replies: string[] = [];
  const edits: string[] = [];
  const ctx = {
    from: opts.userId !== undefined ? { id: opts.userId } : undefined,
    message: opts.hasDoc
      ? { document: { file_name: "f.mp3" }, caption: opts.caption }
      : { text: opts.caption },
    reply: async (text: string) => {
      replies.push(text);
      return { chat: { id: 1 }, message_id: replies.length };
    },
    api: {
      editMessageText: async (_c: number, _m: number, text: string) => {
        edits.push(text);
      },
    },
  } as unknown as Context;
  return { ctx, replies, edits };
}

describe("createFileRunMiddleware", () => {
  const list: ScriptDef[] = [
    {
      name: "echo-args",
      path: `${FIXTURES}/echo-args.sh`,
      description: "test",
      acceptsFile: true,
    },
    {
      name: "no-file",
      path: `${FIXTURES}/echo-args.sh`,
      description: "test",
      acceptsFile: false,
    },
  ];
  const fakeDownload = async () => ({
    path: "/tmp/telegram-bot/fake_test_download.mp3",
    fileName: "fake_test_download.mp3",
  });

  async function run(ctx: Context) {
    const middleware = createFileRunMiddleware({ list, download: fakeDownload });
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    return nextCalled;
  }

  test("no attachment -> calls next(), does not reply", async () => {
    const { ctx, replies } = fakeCtx({ hasDoc: false, caption: "/run echo-args" });
    expect(await run(ctx)).toBe(true);
    expect(replies).toEqual([]);
  });

  test("attachment but non-matching caption -> calls next()", async () => {
    const { ctx, replies } = fakeCtx({ hasDoc: true, caption: "just a photo" });
    expect(await run(ctx)).toBe(true);
    expect(replies).toEqual([]);
  });

  test("matching caption but unauthorized user -> replies Unauthorized, no next()", async () => {
    const { ctx, replies } = fakeCtx({
      hasDoc: true,
      caption: "/run echo-args",
      userId: UNAUTHORIZED_ID,
    });
    expect(await run(ctx)).toBe(false);
    expect(replies.join()).toContain("Unauthorized");
  });

  test("unknown script -> error reply, no next()", async () => {
    const { ctx, replies } = fakeCtx({
      hasDoc: true,
      caption: "/run not-configured",
      userId: AUTHORIZED_ID,
    });
    expect(await run(ctx)).toBe(false);
    expect(replies.join()).toContain("Unknown script");
  });

  test("script with acceptsFile:false -> rejected without downloading", async () => {
    const { ctx, replies } = fakeCtx({
      hasDoc: true,
      caption: "/run no-file",
      userId: AUTHORIZED_ID,
    });
    expect(await run(ctx)).toBe(false);
    expect(replies.join()).toContain("does not accept a file attachment");
  });

  test("{file} placeholder is substituted with the downloaded path", async () => {
    const { ctx, edits } = fakeCtx({
      hasDoc: true,
      caption: "/run echo-args before {file} after",
      userId: AUTHORIZED_ID,
    });
    expect(await run(ctx)).toBe(false);
    expect(edits.join()).toContain("ARG:before");
    expect(edits.join()).toContain("ARG:/tmp/telegram-bot/fake_test_download.mp3");
    expect(edits.join()).toContain("ARG:after");
  });

  test("no placeholder -> downloaded path is appended as the last arg", async () => {
    const { ctx, edits } = fakeCtx({
      hasDoc: true,
      caption: "/run echo-args pl",
      userId: AUTHORIZED_ID,
    });
    expect(await run(ctx)).toBe(false);
    expect(edits.join()).toContain("ARG:pl\nARG:/tmp/telegram-bot/fake_test_download.mp3");
  });

  test("download failure -> error reply", async () => {
    const middleware = createFileRunMiddleware({ list, download: async () => null });
    const { ctx, replies } = fakeCtx({
      hasDoc: true,
      caption: "/run echo-args",
      userId: AUTHORIZED_ID,
    });
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(replies.join()).toContain("Failed to download");
  });
});
