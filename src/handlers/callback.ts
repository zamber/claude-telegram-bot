/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { getSession } from "../ext/session-manager";
import { renameTopicToSessionTitle } from "../ext/session-title";
import {
  DECISION_CODES,
  PERMISSION_CALLBACK_PREFIX,
  parseAskTag,
  resolveAskTap,
  resolvePermission,
} from "../ext/permissions";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Handle resume callbacks: resume:{session_id}
  if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData);
    return;
  }

  // 3. Handle tool-permission callbacks: perm:{request_id}:{code}
  //
  // Two families of code share the prefix:
  //   a|w|d      - Allow / Always / Deny on the generic gate
  //   o<Q><O>, D<Q>, x - the AskUserQuestion option keyboard (see
  //                      ../ext/ask-question)
  // The pending request edits its own message when it settles, so this branch
  // only has to settle the SDK promise and acknowledge the tap.
  if (callbackData.startsWith(PERMISSION_CALLBACK_PREFIX)) {
    const permParts = callbackData.split(":");
    const requestId = permParts[1];
    const code = permParts[2];

    console.log(
      `[Callback] perm tap requestId=${requestId ?? "-"} code=${
        code ?? "-"
      } user=@${username}`
    );

    if (!requestId || !code) {
      await ctx.answerCallbackQuery({ text: "Invalid permission callback" });
      return;
    }

    const decision = DECISION_CODES[code];
    const askTag = decision ? null : parseAskTag(code);

    if (!decision && !askTag) {
      console.warn(
        `[Callback] perm tap with unrecognized code=${code} requestId=${requestId}`
      );
      await ctx.answerCallbackQuery({ text: "Invalid permission callback" });
      return;
    }

    if (askTag) {
      const resolved = resolveAskTap(requestId, code);
      if (!resolved) {
        await ctx.answerCallbackQuery({
          text: "This request expired.",
          show_alert: true,
        });
        return;
      }

      const askToasts: Record<typeof resolved.status, string> = {
        settled: "✅ Answer sent",
        updated: "Selected",
        cancelled: "Cancelled",
        invalid: "Invalid choice",
      };
      await ctx.answerCallbackQuery({ text: askToasts[resolved.status] });
      return;
    }

    const resolved = resolvePermission(requestId, decision!);
    if (!resolved) {
      await ctx.answerCallbackQuery({
        text: "This request expired.",
        show_alert: true,
      });
      return;
    }

    const label =
      decision === "deny"
        ? "Denied"
        : decision === "always"
          ? "Always allowed"
          : "Allowed";
    await ctx.answerCallbackQuery({
      text: `${label}: ${resolved.toolName}`,
    });
    return;
  }

  // 4. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // 3. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 4. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 5. Update the message to show selection. The explicit empty keyboard
  // matters: Telegram keeps the existing reply_markup when an edit omits it, so
  // without this the option buttons outlive the request and a second tap looks
  // like the answer never arrived.
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 6. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 7. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 8. Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

/**
 * Handle resume session callback (resume:{session_id}).
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const session = getSession(ctx);
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const sessionId = callbackData.replace("resume:", "");

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "ID sessione non valido" });
    return;
  }

  // Check if session is already active
  if (session.isActive) {
    await ctx.answerCallbackQuery({ text: "Sessione già attiva" });
    return;
  }

  // Resume the selected session
  const [success, message] = session.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  // Update the original message to show selection, dropping the session list
  // keyboard so a second tap cannot target an already-resumed session.
  try {
    await ctx.editMessageText(`✅ ${message}`, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Sessione ripresa!" });

  // Send a hidden recap prompt to Claude
  const recapPrompt =
    "Please write a very concise recap of where we are in this conversation, to refresh my memory. Max 2-3 sentences.";

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    await session.sendMessageStreaming(
      recapPrompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
  } catch (error) {
    console.error("Error getting recap:", error);
    // Don't show error to user - session is still resumed, recap just failed
  } finally {
    typing.stop();
  }

  // Rename the forum topic to match the resumed session (best-effort). The
  // topic's session binding changed here, so a rename is warranted even though
  // no text message went through handleText.
  if (session.sessionId) {
    await renameTopicToSessionTitle(
      ctx,
      session.sessionId,
      session.conversationTitle
    );
  }
}
