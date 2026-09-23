/**
 * Answer a permission gate by typing a message instead of tapping a button.
 *
 * A pending gate is a promise the Agent SDK is waiting on, and only a button
 * tap could settle it. Typing an answer did nothing useful: `sequentialize`
 * queued the text behind the very query that was blocked, held it for up to
 * PERMISSION_TIMEOUT_MS, and then ran it as a *second* concurrent query once
 * the gate had timed out and denied itself.
 *
 * This middleware is registered BEFORE `sequentialize` in index.ts, and that
 * position is load-bearing:
 *
 *   - After `sequentialize` the text would already be queued behind the gate it
 *     is meant to answer, for up to the full timeout.
 *   - Calling `next()` after settling would run the text again as a fresh
 *     prompt, starting a second query while the first is still resolving.
 *
 * So on a successful settle it answers with a receipt and does NOT call next().
 *
 * When no gate is waiting, the message is passed straight through and the bot
 * behaves exactly as before.
 */

import type { Context, NextFunction } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { keyForCtx } from "./session-manager";
import {
  resolvePendingText,
  type PendingTextResult,
} from "./permissions";

/** The receipt shown after a typed message settles a gate. */
export function typedAnswerReceipt(result: PendingTextResult): string {
  switch (result.status) {
    case "allowed":
      return "✅ Approved. Claude can continue.";
    case "denied":
      return "⛔ Denied. Your message went to Claude as the reason.";
    case "answered":
      return "✅ Answer sent.";
    case "recorded":
      return `📝 Answer recorded for question ${result.questionNumber} of ${result.questionCount}.`;
    case "expired":
      return "";
  }
}

export interface TypedAnswerDeps {
  /** Settle a pending gate by session key. Injectable for tests. */
  resolve?: (sessionKey: string, text: string) => PendingTextResult | null;
  /** Derive the session key from an update. Injectable for tests. */
  keyFor?: (ctx: Context) => string;
}

export function createTypedAnswerMiddleware(deps: TypedAnswerDeps = {}) {
  const resolve = deps.resolve ?? resolvePendingText;
  const keyFor = deps.keyFor ?? keyForCtx;

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const text = ctx.message?.text;
    if (!text) return next();

    const trimmed = text.trim();

    // Commands and the "!" interrupt prefix have their own paths. The interrupt
    // aborts the running query, which aborts any gate it was waiting on, so
    // leaving it alone is what makes "!wait" still work.
    if (trimmed.startsWith("/") || trimmed.startsWith("!")) return next();

    // This runs before the handlers' own authorization checks, so it must do
    // its own. A stranger must never be able to settle a gate. Stay silent
    // rather than reply: a reply would confirm the bot to an unauthorized user.
    if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
      console.warn(`[TypedAnswer] unauthorized user ${ctx.from?.id} ignored`);
      return next();
    }

    let result: PendingTextResult | null;
    try {
      result = resolve(keyFor(ctx), trimmed);
    } catch (error) {
      // Never let a gate bookkeeping bug eat the user's message.
      console.error(`[TypedAnswer] resolve failed: ${error}`);
      return next();
    }

    if (!result) return next();

    // An entry exists but the text cannot apply to it (nothing answered yet on
    // a fully committed card). Treat the message as ordinary input.
    if (result.status === "expired") return next();

    console.log(
      `[TypedAnswer] ${result.status} tool=${result.toolName} user=@${ctx.from?.username ?? ctx.from?.id}`
    );

    try {
      await ctx.reply(typedAnswerReceipt(result), { parse_mode: "HTML" });
    } catch (error) {
      console.warn(`[TypedAnswer] failed to send receipt: ${error}`);
    }
  };
}

export const typedAnswerMiddleware = createTypedAnswerMiddleware();
