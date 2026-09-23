/**
 * Tool-permission round-trip over Telegram inline keyboards.
 *
 * The Agent SDK consults `options.canUseTool()` whenever a tool needs
 * approval. Without that callback the SDK answers the request with a
 * placeholder string ("Exit plan mode?") and the promise never settles — that
 * is what left plan mode permanently stuck, because `ExitPlanMode` is the only
 * tool that can leave it.
 *
 * This module turns each request into an inline-keyboard question in the
 * session's chat and settles the SDK promise when the user taps a button.
 * Requests are keyed by a short random id, so several prompts (and several
 * forum topics) can be pending at the same time without colliding.
 *
 * Two tools carry their own UI and are handled specially:
 *   - ExitPlanMode gets plan-specific wording.
 *   - AskUserQuestion (see ./ask-question) is rendered as the actual question
 *     with one button per option, and the chosen labels travel back to the CLI
 *     inside `updatedInput.answers`. Approving it with a plain Allow button
 *     would tell Claude "User has answered your questions: ." - an empty answer.
 */

import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type {
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { escapeHtml, formatToolStatus } from "../formatting";
import { PERMISSION_TIMEOUT_MS } from "../config";
import {
  applyAskTap,
  buildAskKeyboard,
  newAskProgress,
  parseAskInput,
  parseAskTag,
  renderAskPrompt,
  type AskProgress,
  type AskQuestion,
} from "./ask-question";

/**
 * Re-exported so the callback handler can validate a tap code against the ask
 * protocol while importing the whole protocol from this one module.
 */
export { parseAskTag };

export type PermissionDecision = "allow" | "always" | "deny";

/** Callback-data prefix. Telegram caps callback_data at 64 bytes. */
export const PERMISSION_CALLBACK_PREFIX = "perm:";

/** Decision letters used inside callback_data. */
export const DECISION_CODES: Record<string, PermissionDecision> = {
  a: "allow",
  w: "always",
  d: "deny",
};

type Pending = {
  requestId: string;
  sessionKey: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  chatId: number;
  threadId?: number;
  messageId?: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  respond: (decision: PermissionDecision, denyMessage?: string) => void;
  /**
   * The finalize closure owned by requestPermission. Stored on the entry so
   * taps that arrive from the callback handler settle through the SAME path -
   * one that always resolves the SDK promise.
   */
  settle: (result: PermissionResult, note?: string) => void;
  /** Epoch ms the request was created - used for the settle log line. */
  createdAt: number;
  /** The exact HTML that was sent, so the settle edit can keep the context. */
  promptHtml: string;
  /** Present only for a well-formed AskUserQuestion request. */
  ask?: { questions: AskQuestion[]; progress: AskProgress };
};

const pending = new Map<string, Pending>();

/**
 * The only Bot API methods this module calls. Narrowing the type keeps the
 * production registration honest and lets tests pass a small fake whose
 * argument order is still checked against grammY's real signatures.
 */
export type PermissionApi = Pick<Api, "sendMessage" | "editMessageText">;

let api: PermissionApi | null = null;

/** index.ts registers the Bot API here; this module never imports the bot. */
export function setPermissionApi(botApi: PermissionApi): void {
  api = botApi;
}

export function pendingPermissionCount(): number {
  return pending.size;
}

/** Test-only: forget all pending requests and the registered API. */
export function _resetPermissionsForTest(): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pending.clear();
  api = null;
}

function newRequestId(): string {
  for (let i = 0; i < 10; i++) {
    const id = Math.random().toString(16).slice(2, 10);
    if (!pending.has(id)) return id;
  }
  return Date.now().toString(16).slice(-8);
}

function promptText(entry: Pending): string {
  // AskUserQuestion is the question itself: render it, not a tool name.
  if (entry.ask) {
    return renderAskPrompt(entry.ask.questions);
  }

  if (entry.toolName === "ExitPlanMode") {
    return (
      "🧭 <b>Plan ready — start building?</b>\n\n" +
      "Claude finished planning and wants to leave plan mode. " +
      "Approve to unlock file edits and commands."
    );
  }

  return (
    "🔐 <b>Permission needed</b>\n\n" +
    formatToolStatus(entry.toolName, entry.input) +
    "\n\n<b>Tool:</b> <code>" +
    escapeHtml(entry.toolName) +
    "</code>"
  );
}

function keyboard(entry: Pending): InlineKeyboardMarkup {
  if (entry.ask) {
    return buildAskKeyboard(
      `${PERMISSION_CALLBACK_PREFIX}${entry.requestId}:`,
      entry.ask.questions,
      entry.ask.progress.selected
    );
  }

  const firstRow = [
    {
      text: "✅ Allow",
      callback_data: `${PERMISSION_CALLBACK_PREFIX}${entry.requestId}:a`,
    },
  ];

  // "Always allow" replays the SDK's own suggestions as session rules, so it
  // is only offered when the SDK actually proposed something to remember.
  if (entry.toolName !== "ExitPlanMode" && entry.suggestions?.length) {
    firstRow.push({
      text: "♾️ Always",
      callback_data: `${PERMISSION_CALLBACK_PREFIX}${entry.requestId}:w`,
    });
  }

  return {
    inline_keyboard: [
      firstRow,
      [
        {
          text: "⛔ Deny",
          callback_data: `${PERMISSION_CALLBACK_PREFIX}${entry.requestId}:d`,
        },
      ],
    ],
  };
}

function allowResult(entry: Pending, always: boolean): PermissionResult {
  if (entry.toolName === "ExitPlanMode") {
    // Leaving plan mode must also move the CLI's permission mode off "plan",
    // or the very next tool call is blocked again.
    return {
      behavior: "allow",
      updatedInput: entry.input,
      updatedPermissions: [
        { type: "setMode", mode: "default", destination: "session" },
      ],
    };
  }

  if (always && entry.suggestions?.length) {
    return {
      behavior: "allow",
      updatedInput: entry.input,
      updatedPermissions: entry.suggestions,
    };
  }

  return { behavior: "allow", updatedInput: entry.input };
}

function denyResult(entry: Pending, message: string): PermissionResult {
  return { behavior: "deny", message, interrupt: false };
}

/** The settled text: the original prompt plus the outcome, escaped. */
function settleText(entry: Pending, note: string): string {
  return `${entry.promptHtml}\n\n${escapeHtml(note)} — <code>${escapeHtml(
    entry.toolName
  )}</code>`;
}

/**
 * Rewrite the prompt message to show the outcome and DROP the inline keyboard.
 *
 * Telegram keeps the existing reply_markup when an edit omits it, so without
 * the explicit empty keyboard the buttons outlive the request: the user taps
 * again, the id is gone, and the bot answers "This request expired." - which
 * looks like the answer never reached Claude.
 *
 * Best-effort only: never throws, never delays the SDK promise.
 */
function postSettleNote(entry: Pending, note?: string): void {
  if (!note || entry.messageId === undefined || !api) return;

  try {
    void api
      .editMessageText(entry.chatId, entry.messageId, settleText(entry, note), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      })
      .catch((error) =>
        console.warn(
          `[Permission] Failed to update prompt ${entry.requestId}: ${error}`
        )
      );
  } catch (error) {
    console.warn(
      `[Permission] Failed to update prompt ${entry.requestId}: ${error}`
    );
  }
}

export type PermissionRequest = {
  sessionKey: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  chatId: number;
  threadId?: number;
  signal?: AbortSignal;
  /** Test-only override; production callers use PERMISSION_TIMEOUT_MS. */
  timeoutMs?: number;
};

/**
 * Ask the user, in chat, whether this tool call may run. Resolves with the
 * SDK's PermissionResult. Never throws.
 */
export async function requestPermission(
  req: PermissionRequest
): Promise<PermissionResult> {
  if (!api) {
    return {
      behavior: "deny",
      message: "Permission UI unavailable: bot API not registered.",
    };
  }

  // The SDK can pass a signal that is already aborted (the user pressed stop
  // while the request was in flight). An "abort" listener never fires for an
  // abort that already happened, so check the flag explicitly — otherwise the
  // promise would hang until the timeout.
  if (req.signal?.aborted) {
    return { behavior: "deny", message: "Permission request was cancelled." };
  }

  const requestId = newRequestId();
  let done = false;
  let resolvePromise!: (result: PermissionResult) => void;
  const promise = new Promise<PermissionResult>((res) => {
    resolvePromise = res;
  });

  const entry: Pending = {
    requestId,
    sessionKey: req.sessionKey,
    toolName: req.toolName,
    input: req.input,
    suggestions: req.suggestions,
    chatId: req.chatId,
    threadId: req.threadId,
    timer: undefined,
    respond: () => {},
    settle: () => {},
    createdAt: Date.now(),
    promptHtml: "",
  };

  // A well-formed AskUserQuestion becomes a real question UI. If the input does
  // not match the tool's schema, fall through to the generic Allow/Deny gate.
  if (req.toolName === "AskUserQuestion") {
    const parsed = parseAskInput(req.input);
    if (parsed) {
      entry.ask = { questions: parsed.questions, progress: newAskProgress() };
    } else {
      console.warn(
        `[Permission] ${requestId} AskUserQuestion input did not match the expected shape; using the generic gate`
      );
    }
  }

  function onAbort(): void {
    console.warn(
      `[Permission] abort signal for ${requestId} tool=${entry.toolName}`
    );
    finalize(
      denyResult(entry, "Permission request was cancelled."),
      "🛑 Cancelled"
    );
  }

  function finalize(result: PermissionResult, note?: string): void {
    if (done) return;
    done = true;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(requestId);
    req.signal?.removeEventListener("abort", onAbort);

    console.log(
      `[Permission] settle ${requestId} tool=${entry.toolName} session=${
        entry.sessionKey
      } outcome=${result.behavior}` +
        (result.behavior === "deny" ? ` reason="${result.message}"` : "") +
        ` note="${note ?? "-"}" ageMs=${Date.now() - entry.createdAt}`
    );

    // Settle the SDK promise FIRST. Nothing after this line may delay it or
    // throw into the caller: the timer is already cleared and the entry already
    // removed, so a throw here would strand the SDK promise forever.
    resolvePromise(result);

    // Cosmetic, fire-and-forget, cannot reject unhandled.
    postSettleNote(entry, note);
  }

  // Taps that arrive later (from the callback handler) settle through this
  // same closure, so every path resolves the SDK promise exactly once.
  entry.settle = finalize;

  entry.respond = (
    decision: PermissionDecision,
    denyMessage?: string
  ): void => {
    if (decision === "deny") {
      finalize(
        denyResult(
          entry,
          denyMessage ?? `The user denied permission for ${entry.toolName}.`
        ),
        "⛔ Denied"
      );
      return;
    }
    finalize(
      allowResult(entry, decision === "always"),
      decision === "always" ? "♾️ Always allowed" : "✅ Allowed"
    );
  };

  const timeoutMs = req.timeoutMs ?? PERMISSION_TIMEOUT_MS;
  entry.timer = setTimeout(() => {
    console.warn(
      `[Permission] timeout after ${timeoutMs}ms for ${requestId} tool=${entry.toolName} session=${entry.sessionKey}`
    );
    finalize(
      denyResult(entry, "Permission request timed out with no answer."),
      "⌛ Timed out — denied"
    );
  }, timeoutMs);

  pending.set(requestId, entry);
  req.signal?.addEventListener("abort", onAbort, { once: true });

  console.log(
    `[Permission] request ${requestId} tool=${req.toolName} session=${
      req.sessionKey
    } chat=${req.chatId} thread=${req.threadId ?? "-"} suggestions=${
      req.suggestions?.length ?? 0
    }${entry.ask ? ` askQuestions=${entry.ask.questions.length}` : ""}`
  );

  entry.promptHtml = promptText(entry);

  try {
    const sent = await api.sendMessage(req.chatId, entry.promptHtml, {
      parse_mode: "HTML",
      reply_markup: keyboard(entry),
      ...(req.threadId ? { message_thread_id: req.threadId } : {}),
    });
    entry.messageId = sent.message_id;
    console.log(
      `[Permission] prompt ${requestId} sent message=${sent.message_id}`
    );
  } catch (error) {
    console.error(`[Permission] Failed to send prompt ${requestId}: ${error}`);
    finalize(
      denyResult(entry, `Could not ask the user for permission: ${error}`)
    );
  }

  return promise;
}

/**
 * Apply a button press. Returns the tool that was decided, or null when the
 * request id is unknown (expired, or from a previous process).
 */
export function resolvePermission(
  requestId: string,
  decision: PermissionDecision,
  denyMessage?: string
): { toolName: string; sessionKey: string } | null {
  const entry = pending.get(requestId);
  if (!entry) {
    console.warn(
      `[Permission] tap for unknown request ${requestId} decision=${decision} (expired or pre-restart)`
    );
    return null;
  }

  const { toolName, sessionKey } = entry;
  console.log(
    `[Permission] tap ${requestId} decision=${decision} tool=${toolName} session=${sessionKey} ageMs=${
      Date.now() - entry.createdAt
    }`
  );
  entry.respond(decision, denyMessage);
  return { toolName, sessionKey };
}

export type AskTapStatus = "invalid" | "updated" | "settled" | "cancelled";

/**
 * Apply a tap on an AskUserQuestion option keyboard.
 *
 * Returns null when the request id is unknown. A tap that cannot apply to the
 * current question set returns status "invalid" and leaves the request pending.
 */
export function resolveAskTap(
  requestId: string,
  tag: string
): { toolName: string; sessionKey: string; status: AskTapStatus } | null {
  const entry = pending.get(requestId);
  if (!entry) {
    console.warn(
      `[Permission] ask tap for unknown request ${requestId} tag=${tag} (expired or pre-restart)`
    );
    return null;
  }

  const base = { toolName: entry.toolName, sessionKey: entry.sessionKey };

  if (!entry.ask) {
    console.warn(
      `[Permission] ask tap ${tag} on non-ask request ${requestId} tool=${entry.toolName}`
    );
    return { ...base, status: "invalid" };
  }

  const parsedTag = parseAskTag(tag);
  if (!parsedTag) return { ...base, status: "invalid" };

  const questions = entry.ask.questions;
  const outcome = applyAskTap(questions, entry.ask.progress, parsedTag);
  if (!outcome) return { ...base, status: "invalid" };

  if (outcome.action === "cancel") {
    console.log(
      `[Permission] ask cancel ${requestId} tool=${entry.toolName} session=${entry.sessionKey}`
    );
    entry.settle(
      denyResult(entry, "The user declined to answer the question."),
      "⛔ Cancelled"
    );
    return { ...base, status: "cancelled" };
  }

  entry.ask.progress = outcome.progress;

  if (outcome.action === "update") {
    console.log(
      `[Permission] ask select ${requestId} tag=${tag} tool=${entry.toolName}`
    );
    // Re-render the same message with the new toggle/marker state. No settle.
    if (entry.messageId !== undefined && api) {
      try {
        void api
          .editMessageText(
            entry.chatId,
            entry.messageId,
            entry.promptHtml,
            {
              parse_mode: "HTML",
              reply_markup: buildAskKeyboard(
                `${PERMISSION_CALLBACK_PREFIX}${entry.requestId}:`,
                questions,
                outcome.progress.selected
              ),
            }
          )
          .catch((error) =>
            console.warn(
              `[Permission] Failed to update prompt ${requestId}: ${error}`
            )
          );
      } catch (error) {
        console.warn(
          `[Permission] Failed to update prompt ${requestId}: ${error}`
        );
      }
    }
    return { ...base, status: "updated" };
  }

  // Settled: hand the chosen labels back to the CLI inside updatedInput.answers.
  const answers = outcome.answers;
  console.log(
    `[Permission] ask answered ${requestId} tool=${entry.toolName} session=${
      entry.sessionKey
    } answers=${JSON.stringify(answers)}`
  );

  entry.settle(
    {
      behavior: "allow",
      updatedInput: { ...entry.input, answers },
    },
    outcome.note
  );

  return { ...base, status: "settled" };
}

/**
 * Approve a pending ExitPlanMode request for this session, if there is one.
 * Called by /build so the slash command can actually leave plan mode instead
 * of only flipping the bot-side flag.
 */
export function resolvePendingPlanExit(sessionKey: string): boolean {
  for (const entry of pending.values()) {
    if (entry.sessionKey === sessionKey && entry.toolName === "ExitPlanMode") {
      console.log(
        `[Permission] /build settled pending ExitPlanMode request ${entry.requestId} session=${sessionKey}`
      );
      entry.respond("allow");
      return true;
    }
  }

  console.log(`[Permission] no pending ExitPlanMode for session ${sessionKey}`);
  return false;
}
