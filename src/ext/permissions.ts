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
 */

import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type {
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { escapeHtml, formatToolStatus } from "../formatting";
import { PERMISSION_TIMEOUT_MS } from "../config";

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
  respond: (decision: PermissionDecision) => void;
};

const pending = new Map<string, Pending>();

let api: Api | null = null;

/** index.ts registers the Bot API here; this module never imports the bot. */
export function setPermissionApi(botApi: Api): void {
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

export type PermissionRequest = {
  sessionKey: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  chatId: number;
  threadId?: number;
  signal?: AbortSignal;
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
  };

  function onAbort(): void {
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

    if (note && entry.messageId !== undefined) {
      void api
        ?.editMessageText(entry.chatId, entry.messageId, note)
        .catch(() => {});
    }

    resolvePromise(result);
  }

  entry.respond = (decision: PermissionDecision): void => {
    if (decision === "deny") {
      finalize(
        denyResult(entry, `The user denied permission for ${entry.toolName}.`),
        "⛔ Denied"
      );
      return;
    }
    finalize(
      allowResult(entry, decision === "always"),
      decision === "always" ? "♾️ Always allowed" : "✅ Allowed"
    );
  };

  entry.timer = setTimeout(() => {
    finalize(
      denyResult(entry, "Permission request timed out with no answer."),
      "⌛ Timed out — denied"
    );
  }, PERMISSION_TIMEOUT_MS);

  pending.set(requestId, entry);
  req.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const sent = await api.sendMessage(req.chatId, promptText(entry), {
      parse_mode: "HTML",
      reply_markup: keyboard(entry),
      ...(req.threadId ? { message_thread_id: req.threadId } : {}),
    });
    entry.messageId = sent.message_id;
  } catch (error) {
    console.error(`[Permission] Failed to send prompt: ${error}`);
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
  decision: PermissionDecision
): { toolName: string; sessionKey: string } | null {
  const entry = pending.get(requestId);
  if (!entry) return null;
  const { toolName, sessionKey } = entry;
  entry.respond(decision);
  return { toolName, sessionKey };
}

/**
 * Approve a pending ExitPlanMode request for this session, if there is one.
 * Called by /build so the slash command can actually leave plan mode instead
 * of only flipping the bot-side flag.
 */
export function resolvePendingPlanExit(sessionKey: string): boolean {
  for (const entry of pending.values()) {
    if (entry.sessionKey === sessionKey && entry.toolName === "ExitPlanMode") {
      entry.respond("allow");
      return true;
    }
  }
  return false;
}
