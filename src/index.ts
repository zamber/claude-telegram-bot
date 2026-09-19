/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "./config";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";
import { keyForCtx } from "./ext/session-manager";
import {
  handleRun,
  handleScripts,
  handleHelp,
  handlePlan,
  handleBuild,
  registerBotMenu,
} from "./ext/commands";
import { setOnClaudeCommandsChanged } from "./ext/claude-commands";
import { fileRunMiddleware } from "./ext/file-run-intercept";
import { threadContextMiddleware, installThreadApiTransformer } from "./ext/thread-routing";
import { setPermissionApi } from "./ext/permissions";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Let the permission module post its approve/deny keyboards without importing
// the bot (which would be a cycle: session.ts -> permissions.ts -> index.ts).
setPermissionApi(bot.api);

// Force every outgoing reply/typing-indicator/etc. for this update to carry
// the correct message_thread_id, instead of relying on grammY's shortcuts
// (which only do this when Telegram's is_topic_message flag happens to be
// set - not reliable enough on its own for forum topics to feel correct).
installThreadApiTransformer(bot);
bot.use(threadContextMiddleware);

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // Other messages are sequentialized per chat+thread (so one Telegram
    // forum topic no longer blocks processing in another)
    return keyForCtx(ctx);
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("run", handleRun);
bot.command("scripts", handleScripts);
bot.command("plan", handlePlan);
bot.command("build", handleBuild);
bot.command("help", handleHelp);

// ============== File-attachment /run interceptor ==============
// Must run before the message-type handlers below: on a caption match it
// handles the update itself and does not call next(); otherwise it's a
// no-op passthrough, so normal attachment uploads are unaffected.
bot.use(fileRunMiddleware);

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// Audio messages
bot.on("message:audio", handleAudio);

// Video messages (regular videos and video notes)
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Register the "/" command menu shown in the Telegram client
await registerBotMenu(bot);

// When Claude reports a new slash-command/skill set (from an SDK init
// message), refresh the Telegram "/" menu so it stays in sync. Fire-and-forget
// inside the event loop; errors are logged, never fatal.
setOnClaudeCommandsChanged(async () => {
  try {
    await registerBotMenu(bot);
    console.log("Refreshed Telegram command menu from harvested Claude commands");
  } catch (e) {
    console.warn("Failed to refresh Telegram command menu:", e);
  }
});

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
