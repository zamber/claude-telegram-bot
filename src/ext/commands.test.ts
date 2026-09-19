import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import type { Context } from "grammy";
import { buildMenuEntries, replyWithScriptResult } from "./commands";
import type { ScriptDef } from "./scripts";

const FIXTURES = resolve(import.meta.dir, "__fixtures__");

describe("buildMenuEntries", () => {
  const menu = buildMenuEntries();

  test("includes the existing native commands", () => {
    const names = menu.map((e) => e.command);
    expect(names).toEqual(
      expect.arrayContaining(["new", "stop", "status", "resume", "retry", "restart"])
    );
  });

  test("includes the new script-runner and plan-mode commands", () => {
    const names = menu.map((e) => e.command);
    expect(names).toEqual(
      expect.arrayContaining(["run", "scripts", "plan", "build", "help"])
    );
  });

  test("every entry has a non-empty description (required by setMyCommands)", () => {
    for (const entry of menu) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test("no duplicate command names", () => {
    const names = menu.map((e) => e.command);
    expect(new Set(names).size).toBe(names.length);
  });
});

// Minimal fake ctx covering only what replyWithScriptResult touches:
// ctx.reply(...) and ctx.api.editMessageText(...).
function fakeCtx() {
  const replies: string[] = [];
  const edits: string[] = [];
  const ctx = {
    reply: async (text: string) => {
      replies.push(text);
      return { chat: { id: 1 }, message_id: replies.length };
    },
    api: {
      editMessageText: async (_chatId: number, _msgId: number, text: string) => {
        edits.push(text);
      },
    },
  } as unknown as Context;
  return { ctx, replies, edits };
}

describe("replyWithScriptResult", () => {
  const list: ScriptDef[] = [
    { name: "echo-args", path: `${FIXTURES}/echo-args.sh`, description: "test" },
  ];

  test("unknown script name replies with an error, not a crash", async () => {
    const { ctx, replies } = fakeCtx();
    await replyWithScriptResult(ctx, "does-not-exist", [], list);
    expect(replies.join("\n")).toContain("Unknown script");
    expect(replies.join("\n")).toContain("echo-args");
  });

  test("known script runs and the result is edited into the status message", async () => {
    const { ctx, replies, edits } = fakeCtx();
    await replyWithScriptResult(ctx, "echo-args", ["hello"], list);
    expect(replies.length).toBe(1); // the "Running..." status message
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain("finished");
    expect(edits[0]).toContain("ARG:hello");
  });
});
